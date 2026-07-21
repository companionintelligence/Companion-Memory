import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type EntityIdentifier, type IndexableEntity } from '@ci/domains/search-next';

import { FileChunkEntity, type FileChunk } from '../entities/FileChunkEntity';
import { type CreateChunkDto } from '../types';

@Injectable()
export class DocumentChunkService {
  constructor(
    @InjectRepository(FileChunkEntity)
    private readonly chunkRepository: Repository<FileChunkEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DocumentChunkService.name);
  }

  async createMany(chunks: CreateChunkDto[]): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    const entities = chunks.map((chunk) =>
      this.chunkRepository.create({
        id: uuidv7(),
        fileId: chunk.fileId,
        userId: chunk.userId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        sectionTitle: chunk.sectionTitle,
        sourceLocator: chunk.sourceLocator,
        parserName: chunk.parserName,
        parserVersion: chunk.parserVersion,
        chunkerVersion: chunk.chunkerVersion,
      }),
    );

    const saved = await this.chunkRepository.save(entities);

    this.logger.log('Persisted document chunks', { count: saved.length });

    return saved;
  }

  async deleteByFileId(fileId: string): Promise<void> {
    await this.chunkRepository.delete({ fileId });
  }

  async findByFileId(fileId: string): Promise<FileChunk[]> {
    return this.chunkRepository.find({
      where: { fileId },
      order: { chunkIndex: 'ASC' },
    });
  }

  async findByIds(ids: string[]): Promise<FileChunk[]> {
    if (ids.length === 0) {
      return [];
    }

    return this.chunkRepository.find({
      where: ids.map((id) => ({ id })),
      order: { chunkIndex: 'ASC' },
    });
  }

  /**
   * Time-ordered chunk identifiers for the Memory browse/timed search path.
   * Mirrors the other entity services' `getEntitiesFor*` contract: orders by
   * created_at (DESC by default) with an id tiebreak, and honours the composite
   * (afterTime, afterId) keyset so pagination is stable across the large
   * same-timestamp clusters a single document's chunks produce.
   */
  async getEntitiesForFileChunks(
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
    let query = this.chunkRepository
      .createQueryBuilder('chunk')
      .select('chunk.id', 'id')
      .where('chunk.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('chunk.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('chunk.created_at <= :endTime', { endTime: options.endTime });
    }

    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(chunk.created_at < :afterTime OR (chunk.created_at = :afterTime AND chunk.id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    query = query.orderBy('chunk.created_at', options.order ?? 'DESC').addOrderBy('chunk.id', 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'file-chunk' as IndexableEntity }));
  }
}
