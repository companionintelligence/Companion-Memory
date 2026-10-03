import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { keysetSeek } from '@ci/common/persistence';
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

  /**
   * The first `limit` chunks of one file, in reading order, for a prompt.
   *
   * Scoped to the caller, which {@link findByFileId} is not: that one is a purge helper and takes
   * the file id on the caller's word. Here the chunk row names its owner and the query names the
   * caller, so a file id that is not theirs reads as a file with nothing parsed. The condition is a
   * bound parameter rather than a `find({ where })` object on purpose: an object whose `userId` is
   * undefined silently loses that condition, and this is the read that must never cross owners.
   */
  async findLeadingByFileId(
    context: ServiceContext,
    fileId: string,
    limit: number,
  ): Promise<Pick<FileChunk, 'chunkIndex' | 'content'>[]> {
    if (!context.userId || !fileId || limit < 1) {
      return [];
    }

    const rows = await this.chunkRepository
      .createQueryBuilder('chunk')
      .select(['chunk.chunkIndex', 'chunk.content'])
      .where('chunk.fileId = :fileId', { fileId })
      .andWhere('chunk.userId = :userId', { userId: context.userId })
      .orderBy('chunk.chunkIndex', 'ASC')
      .limit(limit)
      .getMany();

    return rows.map((row) => ({ chunkIndex: row.chunkIndex, content: row.content }));
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
   * updated_at (DESC by default) with an id tiebreak running the same way, and
   * honours the composite (afterTime, afterId) keyset in that direction so
   * pagination is stable across the large same-timestamp clusters a single
   * document's chunks produce.
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
      query = query.andWhere('chunk.updated_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('chunk.updated_at <= :endTime', { endTime: options.endTime });
    }

    const order = options.order ?? 'DESC';

    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        ...keysetSeek('chunk.updated_at', 'chunk.id', order, options.afterTime, options.afterId),
      );
    }

    query = query.orderBy('chunk.updated_at', order).addOrderBy('chunk.id', order);

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'file-chunk' as IndexableEntity }));
  }

  /**
   * True total of document chunks matching the same filters {@link getEntitiesForFileChunks}
   * applies (minus the pagination-only `limit`/`order`/`afterTime`/`afterId`) — a real
   * `COUNT(*)`, not the length of one `limit`-bounded page of identifiers. See
   * CalendarEventService.countEntitiesForEvents.
   */
  async countEntitiesForFileChunks(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date },
  ): Promise<number> {
    let query = this.chunkRepository
      .createQueryBuilder('chunk')
      .where('chunk.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('chunk.updated_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('chunk.updated_at <= :endTime', { endTime: options.endTime });
    }

    return query.getCount();
  }
}
