import { createHash } from 'crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'stream/promises';

import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, type FindOptionsWhere } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { isUniqueViolation } from '@ci/common/constants';
import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { keysetSeek } from '@ci/common/persistence';
import { serves } from '@ci/common/roles';
import config from '@ci/configuration';
import { EventService } from '@ci/domains/events';
import { FileUpdatedEvent, FileUploadedEvent } from '@ci/domains/files/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { SignedFile, FileEntity } from '../entities/FileEntity';
import { FileVariant, type CreateFileDto, type UpdateFileDto, type UploadFileDto } from '../types';

const BUCKET_REGION = config.staticfiles.bucket ?? 'us-east-1';
const SIGNATURE_URL = config.staticfiles.auth.signatureUrl ?? config.staticfiles.storageUrl;

/**
 * Hourly UTC per-user file count. Declared locally so this domain carries no
 * dependency on aggregating consumers; they enforce the shape structurally
 * where they consume it.
 */
export interface HourlyFileCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

/** Shape of every `ci.files.key` — the column is `uuid`, minted by `uuidv4()` on upload. */
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class FileService implements OnModuleInit {
  private s3 = new S3Client({
    endpoint: config.staticfiles.storageUrl,
    // Minio doesn't care about the region, but we're specifying this default just to make S3 happy. May not be needed.
    region: BUCKET_REGION,
    // This is so the client is forced to use http://localhost:9000/example-bucket instead of subdomains.
    // We don't want file paths resolving to http://example-bucket.localhost:9000.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.staticfiles.auth.accessKeyId,
      secretAccessKey: config.staticfiles.auth.secretAccessKey,
    },
  });

  private signatureS3 = new S3Client({
    endpoint: SIGNATURE_URL,
    region: BUCKET_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.staticfiles.auth.accessKeyId,
      secretAccessKey: config.staticfiles.auth.secretAccessKey,
    },
  });

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FileService.name);
  }

  async onModuleInit() {
    // Web-role work: two processes racing HeadBucket→CreateBucket is a boot
    // failure waiting on a timing; the web process (present in every
    // topology) owns ensuring the bucket.
    if (!serves('web')) {
      return;
    }

    try {
      await this.s3.send(
        new HeadBucketCommand({
          Bucket: config.staticfiles.bucket,
        }),
      );

      this.logger.debug('S3 bucket exists, skipping creation');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        this.logger.debug('S3 bucket does not exist, creating a new bucket');

        await this.s3.send(
          new CreateBucketCommand({
            Bucket: config.staticfiles.bucket,
          }),
        );
      } else {
        throw err;
      }
    }
  }

  async create(context: UserServiceContext, file: CreateFileDto): Promise<SignedFile> {
    if (file.externalId) {
      const existing = await this.findByExternalId(context, file.externalId);

      if (existing) {
        this.logger.debug('File with same external ID already exists', {
          existingFileId: existing.id,
        });

        return existing;
      }
    }

    const hash = await this.getFileHash(file);

    // Hash dedup is for ORIGINALS only. A PREVIEW/THUMBNAIL row belongs to
    // its parent; two parents whose derived bytes happen to match are two
    // rows. Deduping them was how previews went missing: the 300px frame of
    // one video is byte-identical to the 300px frame of a re-upload of the
    // same footage, so the SECOND parent's preview resolved to the first's
    // and no row was written for it — the listener then reported success
    // and the file had no thumbnail, permanently. Concurrent preview jobs
    // raced past the check (the ledger showed 20 previews over 14 hashes on
    // one connector alone), which is what made the loss look random.
    if (hash && (file.variant ?? FileVariant.ORIGINAL) === FileVariant.ORIGINAL) {
      const existing = await this.findByHash(context, hash);

      if (existing) {
        this.logger.debug('File with same hash already exists', {
          existingFileId: existing.id,
        });

        return existing;
      }
    }

    const bucket = file.externalId ? null : config.staticfiles.bucket;
    const key = bucket ? uuidv4() : null;

    const entity = this.fileRepository.create({
      id: uuidv7(),
      filename: file.filename,
      contentType: file.contentType ?? 'application/octet-stream',
      size: file.size,
      width: file.width ?? null,
      height: file.height ?? null,
      variant: file.variant ?? FileVariant.ORIGINAL,
      title: file.title ?? null,
      description: file.description ?? null,
      externalId: file.externalId ?? null,
      bucket,
      key,
      hash,
      parentId: file.parentId,
      userId: context.userId,
      externalCreatedAt: file.externalCreatedAt,
      externalUpdatedAt: file.externalUpdatedAt,
      // A direct eventId is stored as-is (trusting the caller — this domain
      // cannot itself validate it belongs to the caller's user without
      // importing the memory domain, which it must never do; see the note on
      // `event_id`/`linkEvent` above). captureTickId's resolution to an
      // eventId, when no direct id is given, happens asynchronously from the
      // memory domain instead — see `linkEvent` below.
      eventId: file.eventId ?? null,
      captureTickId: file.captureTickId ?? null,
    });

    // Bytes BEFORE the row. This used to save first and upload second, so a
    // store refusal (a full disk: "minimum free drive threshold") threw AFTER
    // the row committed — leaving a `ci.files` row that claims bytes nobody
    // holds. A real import leaked 5,258 of them: every consumer 404s on the
    // signed URL, and worse, the row carries the content HASH, so the dedup
    // above then "deduplicates" any future upload of the same bytes against an
    // object that does not exist — a phantom that poisons its own repair.
    // This order fails the other way: a save that dies after a successful PUT
    // strands an unreferenced object in the store, which wastes bytes but
    // breaks nothing and lies to nobody. The one save failure that PROVES no
    // row was written — a unique index refusing it (at most one PLAYBACK per
    // original) — deletes the object it just put, below.
    const uploaded = file.externalId == null && bucket != null && key != null;

    if (uploaded) {
      const putOptions = {
        Bucket: bucket,
        Key: key,
        ContentType: entity.contentType,
      };

      if (file.buffer) {
        await this.s3.send(
          new PutObjectCommand({
            ...putOptions,
            Body: file.buffer,
          }),
        );
      } else if (file.path) {
        await this.s3.send(
          new PutObjectCommand({
            ...putOptions,
            Body: createReadStream(file.path),
          }),
        );
      }
    }

    let result: FileEntity;

    try {
      result = await this.fileRepository.save(entity);
    } catch (err: unknown) {
      // Only a unique violation: any other failure (a dropped connection
      // mid-commit) may have written the row after all, and deleting its
      // bytes then would make exactly the phantom described above.
      if (uploaded && isUniqueViolation(err)) {
        await this.deleteObjects(bucket, [key]).catch((cleanupErr: unknown) => {
          this.logger.warn('Could not delete the object of a file row a unique index refused', {
            bucket,
            key,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        });
      }

      throw err;
    }

    return this.signFile(result);
  }

  /**
   * Stamp `event_id` onto an already-created file — the second half of the
   * capture-correlation resolution described on `FileEntity.eventId`.
   *
   * This domain cannot itself resolve a `captureTickId` to an event (that
   * needs `ci.events`, owned by the memory domain, which this domain must
   * never import). Instead the memory domain resolves it — its
   * `FileUploadedEvent` listener looks up the event carrying the same
   * correlator and calls this — and this method just persists the answer.
   * A targeted write like {@link setDimensions}: no `FileUpdatedEvent`, so
   * linking doesn't fan out a spurious re-index of a file nothing about its
   * own content changed.
   */
  async linkEvent(context: ServiceContext, id: string, eventId: string): Promise<void> {
    await this.fileRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
      { eventId },
    );
  }

  async findAll(context: ServiceContext): Promise<SignedFile[]> {
    const result = await this.fileRepository.find({
      where: {
        variant: FileVariant.ORIGINAL,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      order: {
        createdAt: 'DESC',
      },
    });

    return this.signFiles(result);
  }

  /**
   * One newest-first page of ORIGINAL files, paginated IN SQL.
   *
   * The files browse used to go through {@link findAll}: every page request
   * loaded the whole library and pre-signed a URL for every row before the
   * resolver sliced its 50 — on a real 19,747-file library that is ~20k
   * SigV4 signatures of CPU work on the event loop PER PAGE, which froze the
   * entire API for seconds while it ran (every other request queued behind
   * it) and repeated on every scroll. Here the database returns one page and
   * only that page is signed.
   *
   * Keyset cursor on (created_at, id) rather than OFFSET, so a page stays
   * O(page) however deep the scroll goes and rows created mid-scroll cannot
   * shift the window. The id tiebreak makes the order total — created_at
   * alone left equal-timestamp rows (bulk imports produce many) in an order
   * the planner was free to change between pages, repeating or dropping rows
   * at page seams. An unknown `afterId` reads as "from the start", matching
   * what the in-memory paginator did with a stale cursor.
   *
   * The anchor's `created_at` is read as TEXT, never through the entity. The
   * column is `timestamptz(6)`: microseconds, `DEFAULT now()`, and a bulk
   * upload stamps a whole batch with one. The driver hands an entity's
   * `Date` back at MILLISECONDS (`.123456` reads as `.123`), so a seek bound
   * to it sorted the anchor BEFORE ITSELF: `(created_at, id) < (.123, :id)`
   * is false for every file of the anchor's instant, and the rest of the
   * batch at a page boundary was never served, while `totalCount` counted
   * it. The text is Postgres' own spelling with the microseconds intact, and
   * bound back it is parsed as the column's own type, so the anchor is the
   * file's exact `(created_at, id)`.
   *
   * The seek stays a row-value comparison, not the bounded OR of
   * `keysetSeekExact`: there is no index on `created_at` here today, so both
   * plan as a scan, a filter and a top-N sort, and if one is added this form
   * is the exact index range (see `ItemService.findPage`, which has one).
   */
  async findPage(
    context: ServiceContext,
    page: { limit: number; afterId?: string | null },
  ): Promise<{ files: SignedFile[]; totalCount: number; hasNextPage: boolean }> {
    const scope = {
      variant: FileVariant.ORIGINAL,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    };

    const totalCount = await this.fileRepository.count({ where: scope });

    // The originals this call may see, for the page and for the anchor alike: a file the page could
    // not return (another user's, a variant, a soft-deleted one) is not an anchor either.
    const visible = () => {
      const originals = this.fileRepository
        .createQueryBuilder('file')
        .where('file.variant = :variant', { variant: scope.variant });

      if (scope.userId != null) {
        originals.andWhere('file.user_id = :userId', { userId: scope.userId });
      }

      return originals;
    };

    const query = visible()
      .orderBy('file.created_at', 'DESC')
      .addOrderBy('file.id', 'DESC')
      // One extra row answers hasNextPage without a second count.
      .take(page.limit + 1);

    if (page.afterId) {
      const anchor = await visible()
        .select('file.id', 'anchor_id')
        .addSelect('CAST(file.created_at AS text)', 'anchor_created_at')
        .andWhere('file.id = :anchorId', { anchorId: page.afterId })
        .getRawOne<{ anchor_id: string; anchor_created_at: string | null }>();

      if (anchor?.anchor_created_at != null) {
        query.andWhere('(file.created_at, file.id) < (:anchorCreatedAt, :anchorId)', {
          anchorCreatedAt: anchor.anchor_created_at,
          anchorId: anchor.anchor_id,
        });
      }
    }

    const rows = await query.getMany();
    const hasNextPage = rows.length > page.limit;

    return {
      files: await this.signFiles(rows.slice(0, page.limit)),
      totalCount,
      hasNextPage,
    };
  }

  async findById(context: ServiceContext, id: string): Promise<SignedFile | null> {
    const result = await this.fileRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return result ? this.signFile(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(SignedFile | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    const entities = await this.fileRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const signedFiles = await this.signFiles(entities);

    const map = new Map(signedFiles.map((file) => [file.id, file]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent original files, for the
   * unified search/explorer feed. Restricted to ORIGINAL variants so
   * thumbnails/derivatives don't surface. Full entities resolved downstream.
   */
  async getEntitiesForFiles(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.fileRepository
      .createQueryBuilder('file')
      .select('file.id', 'id')
      .where('file.user_id = :userId', { userId: context.userId })
      .andWhere('file.variant = :variant', { variant: FileVariant.ORIGINAL });

    if (options.startTime) {
      query = query.andWhere('file.updated_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('file.updated_at <= :endTime', { endTime: options.endTime });
    }

    // Composite keyset: page strictly past (afterTime, afterId) in (updated_at, id), in `order`.
    const order = options.order ?? 'DESC';

    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        ...keysetSeek('file.updated_at', 'file.id', order, options.afterTime, options.afterId),
      );
    }

    // Deterministic tiebreak so same-timestamp rows page consistently: the id runs the way the time does.
    query = query.orderBy('file.updated_at', order).addOrderBy('file.id', order);

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'file' as IndexableEntity }));
  }

  /**
   * True total of files matching the same filters {@link getEntitiesForFiles} applies (minus
   * the pagination-only `limit`/`order`/`afterTime`/`afterId`) — a real `COUNT(*)`, not the
   * length of one `limit`-bounded page of identifiers. See CalendarEventService.countEntitiesForEvents.
   */
  async countEntitiesForFiles(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date },
  ): Promise<number> {
    let query = this.fileRepository
      .createQueryBuilder('file')
      .where('file.user_id = :userId', { userId: context.userId })
      .andWhere('file.variant = :variant', { variant: FileVariant.ORIGINAL });

    if (options.startTime) {
      query = query.andWhere('file.updated_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('file.updated_at <= :endTime', { endTime: options.endTime });
    }

    return query.getCount();
  }

  async findByHash(context: UserServiceContext, fileHash: string): Promise<SignedFile | null> {
    const result = await this.fileRepository.findOne({
      where: {
        hash: fileHash,
        userId: context.userId,
      },
    });

    if (result == null) {
      return null;
    }

    return this.signFile(result);
  }

  async findByExternalId(context: UserServiceContext, externalId: string): Promise<SignedFile | null> {
    const result = await this.fileRepository.findOne({
      where: {
        externalId,
        userId: context.userId,
      },
    });

    if (result == null) {
      return null;
    }

    return this.signFile(result);
  }

  async findVariantByParentId(
    context: ServiceContext,
    id: string,
    variant: FileVariant,
  ): Promise<SignedFile | null> {
    const result = await this.fileRepository.findOne({
      where: {
        parentId: id,
        variant,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (result == null) {
      return null;
    }

    return this.signFile(result);
  }

  async findVariantsByParentIds(
    context: ServiceContext,
    parentIds: string[],
    variant: FileVariant,
  ): Promise<(SignedFile | null)[]> {
    const byKind = await this.findVariantsOfKindsByParentIds(context, parentIds, [variant]);

    return byKind[variant];
  }

  /**
   * Several variant kinds of each parent in ONE query — the PREVIEW and the
   * PLAYBACK of a page of media originals, say. Each kind comes back aligned
   * with `parentIds` (null where that parent has none), the shape
   * {@link findVariantsByParentIds} returns for one kind.
   *
   * A loader that needs two derivatives calls this rather than
   * `findVariantsByParentIds` once per kind, so a page stays one variants
   * query per hop: PLAYBACK added beside PREVIEW as a second call doubled the
   * content and event media loaders' query count
   * (ContentResolver.batching.test.ts holds the count).
   */
  async findVariantsOfKindsByParentIds<V extends FileVariant>(
    context: ServiceContext,
    parentIds: string[],
    variants: readonly V[],
  ): Promise<Record<V, (SignedFile | null)[]>> {
    // Keyed by the column's own type: `ci.files.variant` is a varchar.
    const byKind = new Map<string, Map<string | null, SignedFile>>(
      variants.map((variant) => [variant, new Map()]),
    );

    if (parentIds.length > 0 && variants.length > 0) {
      const entities = await this.fileRepository.find({
        where: {
          parentId: In(parentIds),
          variant: In([...variants]),
          ...(context.userId !== SYSTEM_USER && {
            userId: context.userId,
          }),
        },
      });

      for (const file of await this.signFiles(entities)) {
        byKind.get(file.variant)?.set(file.parentId, file);
      }
    }

    return Object.fromEntries(
      variants.map((variant) => [variant, parentIds.map((id) => byKind.get(variant)?.get(id) ?? null)]),
    ) as Record<V, (SignedFile | null)[]>;
  }

  async upload(context: UserServiceContext, file: UploadFileDto): Promise<SignedFile> {
    const { file: uploaded } = await this.uploadWithDedupInfo(context, file);

    return uploaded;
  }

  /**
   * Same upload pipeline as {@link upload} (hash-dedup against the store,
   * create + FileUploadedEvent fan-out for new content), but ALSO reports
   * whether the content was deduplicated against an already-stored file —
   * `deduped: true` means no new file row/object was created and `file` is the
   * pre-existing one. Extracted so the batch `POST /v1/files` endpoint can
   * honor its per-input `{ filename, sha256, id, deduped }` contract without
   * forking the pipeline; `upload` (and thus `POST /files/upload`) delegates
   * here and behaves exactly as before.
   */
  async uploadWithDedupInfo(
    context: UserServiceContext,
    file: UploadFileDto,
  ): Promise<{ file: SignedFile; deduped: boolean }> {
    const { thingCapture = false, skipDescription = false, model, ...uploadData } = file;
    const hash = await this.getFileHash(uploadData);

    if (hash) {
      const existing = await this.findByHash(context, hash);

      if (existing) {
        this.logger.debug('File with same hash already exists, skipping upload', {
          existingFileId: existing.id,
        });

        if (thingCapture) {
          await this.eventService.send(FileUploadedEvent, {
            fileId: existing.id,
            userId: context.userId,
            thingCapture: true,
            skipDescription,
            model,
          });
        }

        return { file: existing, deduped: true };
      }
    }

    const created = await this.create(context, {
      ...uploadData,
      variant: FileVariant.ORIGINAL,
    });

    await this.eventService.send(FileUploadedEvent, {
      fileId: created.id,
      userId: context.userId,
      thingCapture,
      skipDescription,
      model,
    });

    return { file: created, deduped: false };
  }

  async putObject(_context: ServiceContext, bucket: string, key: string, body: Buffer): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
      }),
    );
  }

  /**
   * Delete objects from a bucket.
   *
   * Written for the account purge: until it existed nothing in this repository
   * ever deleted an object, so every file an account uploaded outlived the row
   * that pointed at it. S3's batch delete is idempotent for missing keys, which
   * is what lets the purge re-run a page it already processed.
   *
   * `Quiet: true` suppresses the per-key success list; genuine failures still
   * come back in `Errors`, and one of those means the bytes are still there, so
   * it is raised rather than logged.
   */
  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    // The API caps one DeleteObjects call at 1000 keys.
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const page = keys.slice(offset, offset + 1000);

      const response = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: page.map((Key) => ({ Key })), Quiet: true },
        }),
      );

      if (response.Errors && response.Errors.length > 0) {
        const [first] = response.Errors;

        throw new Error(
          `Failed to delete ${response.Errors.length} object(s) from ${bucket}: ${first.Key} — ${first.Message}`,
        );
      }
    }
  }

  /**
   * Refuse a by-key read unless the caller owns the `ci.files` row that points
   * at `key`. Object keys are minted UUIDs, but they are not secrets — they ride
   * in every presigned `/static/` URL — and the two readers below took any key
   * on the caller's word, so a key learned from someone else's share link (or
   * planted in a row, as the account import once allowed) came back as bytes.
   * The check is on the ROW, not the object: ownership is a fact about
   * `ci.files.user_id`, and a soft-deleted row still names its owner, so the
   * lookup includes deleted rows (export reads those too). It runs once per
   * read, per file, in every background pass, so it must stay a single probe
   * of `files_user_id_key_idx` (user_id, key) — keep both columns in the WHERE.
   *
   * The system principal is exempt, exactly as every other scoped lookup in
   * this service exempts it: background jobs act for the appliance, not for a
   * person, and carry no user to check against.
   *
   * A key that is not even UUID-shaped cannot match any row (the column is
   * `uuid`), so it is refused up front rather than handed to Postgres to
   * reject with a type error.
   */
  private async assertOwnsKey(context: ServiceContext, key: string): Promise<void> {
    if (context.userId === SYSTEM_USER) {
      return;
    }

    if (!UUID_KEY.test(key)) {
      throw new NotFoundException('File not found');
    }

    const owned = await this.fileRepository.findOne({
      where: { key, userId: context.userId },
      select: ['id'],
      withDeleted: true,
    });

    if (!owned) {
      throw new NotFoundException('File not found');
    }
  }

  async getFileContent(context: ServiceContext, key: string): Promise<Uint8Array> {
    await this.assertOwnsKey(context, key);

    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: config.staticfiles.bucket,
        Key: key,
      }),
    );

    if (response.Body) {
      return response.Body.transformToByteArray();
    }

    throw new Error(`S3 object body was empty for key: ${key}`);
  }

  async getFileStream(context: ServiceContext, key: string): Promise<Readable> {
    await this.assertOwnsKey(context, key);

    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: config.staticfiles.bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`S3 object body was empty for key: ${key}`);
    }

    // AWS SDK v3 SdkStream implements Symbol.asyncIterator, so we can
    // wrap it in a Node Readable without unsafe casts or web-stream mismatches.
    return Readable.from(response.Body as AsyncIterable<Uint8Array>);
  }

  async update(context: ServiceContext, id: string, data: UpdateFileDto): Promise<SignedFile | null> {
    const result = await this.fileRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
      data,
    );

    // No row matched (unknown id, or one owned by another user) — don't emit a
    // spurious FileUpdatedEvent to downstream re-index listeners.
    if (!result.affected) {
      return null;
    }

    await this.eventService.send(FileUpdatedEvent, { fileId: id });

    return this.findById(context, id);
  }

  /**
   * Persist the intrinsic pixel dimensions onto a file row.
   *
   * A targeted write — deliberately NOT routed through {@link update}: it skips
   * the `FileUpdatedEvent` (so the dimensions backfill recording ~18.8k files
   * doesn't fan out a flood of no-op re-index jobs) and writes width/height,
   * which the user-facing {@link UpdateFileDto} doesn't expose. User-scoped like
   * the rest of the service (SYSTEM_USER bypasses the scope).
   */
  async setDimensions(
    context: ServiceContext,
    id: string,
    dimensions: { width: number | null; height: number | null },
  ): Promise<void> {
    await this.fileRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
      { width: dimensions.width, height: dimensions.height },
    );
  }

  async search(context: ServiceContext, query: FindOptionsWhere<FileEntity>): Promise<FileEntity[]> {
    return this.fileRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        ...query,
      },
    });
  }

  async getFileHash(file: CreateFileDto): Promise<string | null> {
    if (file.buffer) {
      return createHash('sha256').update(file.buffer).digest('hex');
    }

    if (file.path) {
      const hash = createHash('sha256');

      await pipeline(createReadStream(file.path), hash);

      return hash.digest('hex');
    }

    return null;
  }

  private async signFiles(files: FileEntity[]): Promise<SignedFile[]> {
    return Promise.all(files.map(this.signFile.bind(this)));
  }

  private async signFile(file: FileEntity): Promise<SignedFile> {
    const bucket = file.bucket;
    const key = file.key;

    if (bucket == null || key == null) {
      return {
        ...FileEntity.toEgressType(file),
        url: file.externalId,
      };
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: file.contentType,
    });

    const url = await getSignedUrl(this.signatureS3, command, {
      expiresIn: config.staticfiles.auth.signatureTTL,
    });

    const parsedUrl = new URL(url);

    return {
      ...FileEntity.toEgressType(file),
      url: parsedUrl.pathname + parsedUrl.search,
    };
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: files counted by
   * creation time, per user. Soft-deleted files are excluded automatically by
   * the query builder (FileEntity has a @DeleteDateColumn); ownerless rows are
   * skipped.
   */
  async aggregateHourlyActivity(): Promise<HourlyFileCount[]> {
    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> = await this.fileRepository
      .createQueryBuilder('file')
      .select('file.userId', 'user_id')
      .addSelect(`date_trunc('hour', file.createdAt, 'UTC')`, 'bucket_start')
      .addSelect('COUNT(*)::int', 'count')
      .where('file.userId IS NOT NULL')
      .groupBy('user_id')
      .addGroupBy('bucket_start')
      .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }

  /**
   * Originals that are still missing a description but already have a PREVIEW
   * child — candidates to re-fire {@link PreviewGeneratedEvent} after the user
   * turns image description back on. Images and videos alike: a video's
   * preview is one extracted frame, and the description listener samples
   * more from the original. Until 2026-09-22 this said `image/%` alone, and
   * every video in the measured library (519) sat undescribed for it.
   *
   * Newest first, paged by keyset on the original's id: `afterParentFileId`
   * returns the page strictly older than that id. Ids are UUIDv7, so id order
   * is creation order, and a cursor on it is stable while the descriptions
   * the previous page enqueued are still being written (an OFFSET would slide
   * as rows leave the "undescribed" set).
   */
  async findUndescribedImagePreviews(
    userId: string,
    limit: number,
    afterParentFileId?: string,
  ): Promise<Array<{ previewId: string; parentFileId: string }>> {
    const rows: Array<{ preview_id: string; parent_file_id: string }> = await this.fileRepository
      .createQueryBuilder('preview')
      .innerJoin(
        FileEntity,
        'original',
        'original.id = preview.parentId AND original.userId = preview.userId',
      )
      .select('preview.id', 'preview_id')
      .addSelect('original.id', 'parent_file_id')
      .where('preview.userId = :userId', { userId })
      .andWhere('preview.variant = :previewVariant', { previewVariant: FileVariant.PREVIEW })
      .andWhere('original.variant = :originalVariant', { originalVariant: FileVariant.ORIGINAL })
      .andWhere('(original.contentType LIKE :imagePrefix OR original.contentType LIKE :videoPrefix)', {
        imagePrefix: 'image/%',
        videoPrefix: 'video/%',
      })
      .andWhere("(original.description IS NULL OR btrim(original.description) = '')")
      .andWhere(afterParentFileId ? 'original.id < :afterParentFileId' : 'TRUE', { afterParentFileId })
      .orderBy('original.id', 'DESC')
      .limit(Math.max(1, Math.min(limit, 2000)))
      .getRawMany();

    return rows.map((row) => ({ previewId: row.preview_id, parentFileId: row.parent_file_id }));
  }

  /**
   * How much of the user's photo library a subject search can actually see.
   *
   * A photo reaches the search index through its title, description, filename
   * and content type ({@link fileWeightedTexts}); of those, only the
   * description — written by the image-description pass — says what the
   * picture is OF. So "how many photos of rabbits" is really a question about
   * the described subset, and a count that does not say how big that subset
   * is invites the model to present a floor as a total. Measured 2026-09-16:
   * 5,393 of 22,870 originals described.
   *
   * Counts ORIGINALs only (previews and thumbnails are derived copies of the
   * same picture and are not indexed) and treats a blank description as
   * absent, the same predicate {@link findUndescribedImagePreviews} uses to
   * decide what is still owed a description.
   */
  async describedImageCoverage(context: UserServiceContext): Promise<{ images: number; described: number }> {
    const rows: Array<{ images: string; described: string }> = await this.fileRepository.query(
      `
        SELECT
          count(*) AS images,
          count(*) FILTER (WHERE description IS NOT NULL AND btrim(description) <> '') AS described
        FROM ci.files
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND variant = $2
          AND content_type LIKE 'image/%'
      `,
      [context.userId, FileVariant.ORIGINAL],
    );

    return {
      images: Number(rows[0]?.images ?? 0),
      described: Number(rows[0]?.described ?? 0),
    };
  }

  /**
   * Every user who owns at least one image {@link findUndescribedImagePreviews}
   * would return a row for — an EXISTS check, not the rows themselves.
   *
   * Exists for {@link ImageDescriptionSweepCron}: cheap enough to run over
   * every user before the far more expensive per-user check (a live Ollama
   * round trip, via `ImageDescriptionPreferenceService.isEnabled`) that
   * decides whether the setting is actually on for them. A user with nothing
   * left to describe — or nothing that ever needed describing — never reaches
   * that second check.
   */
  async listUserIdsWithUndescribedImages(): Promise<string[]> {
    const rows: Array<{ user_id: string }> = await this.fileRepository
      .createQueryBuilder('original')
      .select('DISTINCT original.userId', 'user_id')
      .innerJoin(
        FileEntity,
        'preview',
        'preview.parentId = original.id AND preview.userId = original.userId AND preview.variant = :previewVariant',
        { previewVariant: FileVariant.PREVIEW },
      )
      .where('original.variant = :originalVariant', { originalVariant: FileVariant.ORIGINAL })
      .andWhere('(original.contentType LIKE :imagePrefix OR original.contentType LIKE :videoPrefix)', {
        imagePrefix: 'image/%',
        videoPrefix: 'video/%',
      })
      .andWhere("(original.description IS NULL OR btrim(original.description) = '')")
      .andWhere('original.userId IS NOT NULL')
      .getRawMany();

    return rows.map((row) => row.user_id);
  }
}
