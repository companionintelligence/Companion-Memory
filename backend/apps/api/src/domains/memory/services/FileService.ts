import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type RequestContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import {
  FileService as FileStorageService,
  FileUploadedEvent,
  type FileUploadedPayload,
} from '@ci/domains/files';
import { CreateFileDto } from '@ci/domains/memory/types';

import { FileEntity } from '../entities/FileEntity';

@Injectable()
export class FileService {
  constructor(
    private readonly fileService: FileStorageService,
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly logger: LoggerService,
  ) {}

  async create(context: RequestContext, data: CreateFileDto): Promise<{ entity: FileEntity }> {
    const { name, linkedId } = data;

    const existingEntity = await this.fileRepository
      .createQueryBuilder('entity')
      .andWhere("entity.linked_table = 'files'")
      .andWhere('entity.linked_id = :linkedId', { linkedId })
      .getOne();

    let entity = !existingEntity
      ? await this.fileRepository.create({
          id: uuidv7(),
          name,
          entity_type: 'File',
          description: 'File',
          linked_table: 'files',
          linked_id: linkedId,
          user: {
            id: context.userId,
          },
        })
      : existingEntity;

    entity = await this.fileRepository.save(entity);

    return { entity };
  }

  @OnEvent(FileUploadedEvent)
  async handleFileUploaded(payload: FileUploadedPayload) {
    const file = await this.fileService.findById({ userId: payload.userId }, payload.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping entity creation', {
        fileId: payload.fileId,
      });

      return;
    }

    const existingEntity = await this.fileRepository
      .createQueryBuilder('entity')
      .andWhere("entity.linked_table = 'files'")
      .andWhere('entity.linked_id = :fileId', { fileId: file.id })
      .getOne();

    const entity = !existingEntity
      ? await this.fileRepository.create({
          id: uuidv7(),
          name: file.filename,
          entity_type: 'File',
          description: 'File',
          linked_table: 'files',
          linked_id: file.id,
          user: {
            id: payload.userId,
          },
        })
      : existingEntity;

    await this.fileRepository.save(entity);
  }
}
