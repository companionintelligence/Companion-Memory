import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService, OnEvent } from '@ci/domains/events';
import {
  FileService as FileStorageService,
  FileRemovedEvent,
  FileUploadedEvent,
  type FileUploadedPayload,
  // Aliased — this file's own `File` (below) is the graph-shadow node type,
  // a different shape entirely from the files domain's stored-file egress
  // type this alias names.
  type SignedFile as StoredFile,
} from '@ci/domains/files';
import { CreateFileDto } from '@ci/domains/memory/types';

import { EventEntity } from '../entities/EventEntity';
import { type File, FileEntity } from '../entities/FileEntity';

import { EntityService } from './EntityService';
import { nothingPurged, purgeFileAggregates, StoredObjectsDeletedError, type PurgedFiles } from './filePurge';

/** Where the graph-node write for an upload runs, off the shared default queue. */
export const MEMORY_FILE_ENTITY_QUEUE = 'memory-file-entity';

/**
 * The queue this handler consumed on before the move to
 * {@link MEMORY_FILE_ENTITY_QUEUE}. Spelled out rather than imported because
 * `DEFAULT_QUEUE` is internal to the events domain (no-cross-domain-internals).
 */
export const LEGACY_FILE_ENTITY_QUEUE = 'default';

@Injectable()
export class FileService extends EntityService<FileEntity, File> {
  constructor(
    private readonly fileStorageService: FileStorageService,
    @InjectRepository(FileEntity)
    fileRepository: Repository<FileEntity>,
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    super(fileRepository, FileEntity);
    this.logger.setContext(FileService.name);
  }

  async create(context: UserServiceContext, data: CreateFileDto): Promise<{ entity: FileEntity }> {
    const { name, linkedId } = data;

    // A file graph row IS the link to its ci.files record; without the id there
    // is nothing to represent (and the DB's linked_table_consistency CHECK
    // would reject the row anyway).
    if (linkedId == null) {
      throw new Error('CreateFileDto.linkedId is required to create a file entity');
    }

    const entity = await this.findOrCreateForFile(context, linkedId, name ?? null);

    return { entity };
  }

  /**
   * Permanently deletes stored files, with everything that only exists because of them:
   * the `File` node, the `ci.files` row it shadows, every variant, their chunks and
   * search rows, and the objects in the object store. This is `memory.forget`'s
   * `archive_and_delete` for a `File` node: see {@link purgeFileAggregates} for what goes,
   * what stays, and why the objects are deleted before the rows.
   *
   * Everything in the database is one transaction. Search is told afterwards, so a
   * listener that looks finds the files gone, and the ids that were not the caller's,
   * or have no `ci.files` row behind them, are left out of the result.
   *
   * @throws {StoredObjectsDeletedError} if the objects were deleted and the rows then
   *   could not be, which leaves files the app still lists whose contents are gone.
   *   Anything that failed before that left everything as it was.
   */
  async purge(context: UserServiceContext, nodeIds: string[]): Promise<PurgedFiles> {
    const requested = Array.from(new Set(nodeIds));

    if (requested.length === 0) {
      return nothingPurged();
    }

    // Named by the purge itself once the objects are gone, and read here rather than there
    // because the commit that follows can fail too.
    let objectsGoneFor: string[] = [];
    let purged: PurgedFiles;

    try {
      purged = await this.repository.manager.transaction((manager) =>
        purgeFileAggregates(manager, context.userId, requested, this.fileStorageService, {
          onObjectsDeleted: (namedNodeIds) => {
            objectsGoneFor = namedNodeIds;
          },
        }),
      );
    } catch (error) {
      throw objectsGoneFor.length > 0 ? new StoredObjectsDeletedError(objectsGoneFor, error) : error;
    }

    // The index rows were deleted in the transaction. This tells anything else that
    // listens, and is what announces a removal everywhere else in the app.
    for (const fileId of purged.fileIds) {
      await this.eventService.send(FileRemovedEvent, { fileId });
    }

    return purged;
  }

  @OnEvent(FileUploadedEvent, { queue: MEMORY_FILE_ENTITY_QUEUE })
  async handleFileUploaded(payload: FileUploadedPayload) {
    await this.createEntityForUploadedFile(payload);
  }

  /**
   * Drain for `file.uploaded` jobs enqueued before the handler moved to
   * {@link MEMORY_FILE_ENTITY_QUEUE} — the same registration
   * `ImportStageListener` keeps on its pre-split queue, for the same reason.
   * `file.uploaded` is the appliance's highest-volume job, so a deploy always
   * lands on some sitting in `created` on `default`; with nothing bound to
   * `file.uploaded:default` the worker fetches each one, matches no listener
   * and completes it, and that file never gets a graph File node — nothing
   * else mints one. New sends fan out here as well, which costs one extra
   * (idempotent) lookup per upload; delete this once a deployment has drained
   * the queue.
   */
  @OnEvent(FileUploadedEvent, { queue: LEGACY_FILE_ENTITY_QUEUE })
  async drainFileUploadedFromDefaultQueue(payload: FileUploadedPayload) {
    await this.createEntityForUploadedFile(payload);
  }

  private async createEntityForUploadedFile(payload: FileUploadedPayload) {
    const file = await this.fileStorageService.findById({ userId: payload.userId }, payload.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping entity creation', {
        fileId: payload.fileId,
      });

      return;
    }

    await this.linkCaptureEvent(payload.userId, file);
    await this.findOrCreateForFile({ userId: payload.userId }, file.id, file.filename);
  }

  /**
   * Best-effort: link a file to the `ci.events` row from the same CI-Capture
   * worker tick, via the `capture_tick_id` correlator CI-Capture stamps on
   * both (see EventEntity.captureTickId / migration
   * 20260830042159_add_capture_correlation_to_files_and_events). Lives here
   * rather than in the files domain — that domain must never import
   * `EventEntity` (see the note on `FileEntity.eventId` in the files
   * domain), so this is the one side that CAN resolve the correlator: this
   * class already sits in the memory domain and already holds a
   * `FileStorageService` reference to write the answer back.
   *
   * A miss (no matching event, or the file already carries an eventId — an
   * explicit direct link wins and is never overwritten) is not an error: the
   * screenshot upload and the vizier event ingest race independently, so the
   * event legitimately may not exist yet when this listener runs.
   * `captureTickId` stays stamped on the file regardless (see FileService in
   * the files domain), so a future repair pass — the same shape as
   * 20260819064129_link_content_to_events_by_triple.sql for content/events —
   * can still catch it.
   */
  private async linkCaptureEvent(userId: string, file: StoredFile): Promise<void> {
    if (file.eventId || !file.captureTickId) {
      return;
    }

    const event = await this.eventRepository.findOne({
      where: { userId, captureTickId: file.captureTickId },
      order: { createdAt: 'DESC' },
    });

    if (!event) {
      return;
    }

    await this.fileStorageService.linkEvent({ userId }, file.id, event.id);
  }

  /**
   * Idempotent graph-presence upsert for a `ci.files` row. The lookup runs on
   * the STI child repository, which scopes it to `entity_type = 'File'` — the
   * pre-STI code matched rows of ANY type holding the linked key. An existing
   * row is returned as-is (the old path re-saved it, which only bumped
   * `updated_at`); a new row is persisted via
   * {@link EntityService.persistCreate}.
   */
  private async findOrCreateForFile(
    context: UserServiceContext,
    fileId: string,
    name: string | null,
  ): Promise<FileEntity> {
    const where = { linkedTable: 'files', linkedId: fileId };

    const existing = await this.repository.findOne({ where });

    if (existing) {
      return existing;
    }

    try {
      return await this.repository.manager.transaction((manager) => {
        const instance = this.repository.create({
          id: uuidv7(),
          name,
          description: 'File',
          linkedTable: 'files',
          linkedId: fileId,
          userId: context.userId,
          properties: {},
        });

        return this.persistCreate(manager, instance);
      });
    } catch (err) {
      // Lost a race to a concurrent findOrCreateForFile for the same file id
      // (entities_linked_uniq, 23505) — a re-fired FileUploadedEvent can land
      // two handlers on this at once. Return the winner instead of throwing;
      // the recovery query must run outside the failed transaction, which
      // aborted on the violation (25P02 on any further query on that manager).
      if ((err as { code?: string })?.code === '23505') {
        const winner = await this.repository.findOne({ where });
        if (winner) {
          return winner;
        }
      }

      throw err;
    }
  }
}
