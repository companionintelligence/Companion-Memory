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

  @OnEvent(FileUploadedEvent)
  async handleFileUploaded(payload: FileUploadedPayload) {
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
    const existing = await this.repository.findOne({
      where: { linkedTable: 'files', linkedId: fileId },
    });

    if (existing) {
      return existing;
    }

    return this.repository.manager.transaction((manager) => {
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
  }
}
