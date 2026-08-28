import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import {
  FileService as FileStorageService,
  FileUploadedEvent,
  type FileUploadedPayload,
} from '@ci/domains/files';
import { CreateFileDto } from '@ci/domains/memory/types';

import { type File, FileEntity } from '../entities/FileEntity';

import { EntityService } from './EntityService';

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

    await this.findOrCreateForFile({ userId: payload.userId }, file.id, file.filename);
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
