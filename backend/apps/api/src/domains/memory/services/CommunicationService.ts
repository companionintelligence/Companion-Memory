import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, type FindOptionsOrder } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { bulkInsertIdempotent } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { CommunicationEntity, Communication } from '../entities/CommunicationEntity';
import { CommunicationCreatedEvent, CommunicationUpdatedEvent, CommunicationRemovedEvent } from '../events';
import { CreateCommunicationDto, UpdateCommunicationDto } from '../types';

interface Options {
  limit?: number;
  order?: FindOptionsOrder<CommunicationEntity>;
  startTime?: Date;
  endTime?: Date;
  /** Composite keyset cursor for the timed search path (see EventService). */
  afterTime?: Date;
  afterId?: string;
}

@Injectable()
export class CommunicationService {
  constructor(
    @InjectRepository(CommunicationEntity)
    private readonly communicationRepository: Repository<CommunicationEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
    private readonly dataSource: DataSource,
  ) {
    this.logger.setContext(CommunicationService.name);
  }

  async create(context: UserServiceContext, data: CreateCommunicationDto): Promise<Communication> {
    const id = data.id ?? uuidv7();

    const communication = this.communicationRepository.create({
      id,
      time: data.time,
      communicationType: data.communication_type,
      userId: context.userId,
      deviceId: data.device_id,
      direction: data.direction,
      threadId: data.thread_id,
      fromEntityId: data.from_entity_id,
      toEntityIds: data.to_entity_ids || [],
      participantsMetadata: data.participants_metadata || {},
      subject: data.subject,
      content: data.content,
      durationSeconds: data.duration_seconds,
      sentimentScore: data.sentiment_score,
      importanceScore: data.importance_score,
      urgencyScore: data.urgency_score,
      category: data.category,
      summary: data.summary,
      connectionId: data.connection_id,
      attachments: data.attachments || [],
      isEncrypted: data.is_encrypted || false,
      isArchived: data.is_archived || false,
      preview: data.preview ?? null,
      sourceType: data.source_type ?? null,
      sourceSystem: data.source_system ?? null,
      sourceId: data.source_id ?? null,
    });

    // TODO: Build relationships using from_entity_id and to_entity_ids

    const communicationResult = await this.communicationRepository.save(communication);

    await this.eventService.send(CommunicationCreatedEvent, {
      communicationId: communicationResult.id,
    });

    return CommunicationEntity.toEgressType(communicationResult);
  }

  /**
   * Batch, idempotent communication ingest for the importer. Dedupes on the
   * provenance triple (source_type, source_system, source_id), scoped to the user,
   * via one set-based INSERT ... ON CONFLICT DO NOTHING instead of a per-row
   * findOne + save loop (the old path was N findOnes + N inserts and throttled the
   * ~1M-row importer push). Re-syncing the same triple returns the existing row
   * without inserting a duplicate. Paired with the communications_source_triple_uniq
   * partial unique index (which carries `time`, a hypertable partition key the
   * importer keeps stable per source row); ON CONFLICT also absorbs a lost insert
   * race. A CommunicationCreatedEvent is emitted for each newly-inserted row only
   * (the embedding/search pipeline listens for these).
   */
  async createMany(context: UserServiceContext, data: CreateCommunicationDto[]): Promise<Communication[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.communicationRepository.create({
        id: item.id ?? uuidv7(),
        time: item.time,
        communicationType: item.communication_type,
        userId: context.userId,
        deviceId: item.device_id,
        direction: item.direction,
        threadId: item.thread_id,
        fromEntityId: item.from_entity_id,
        toEntityIds: item.to_entity_ids || [],
        participantsMetadata: item.participants_metadata || {},
        subject: item.subject,
        content: item.content,
        durationSeconds: item.duration_seconds,
        sentimentScore: item.sentiment_score,
        importanceScore: item.importance_score,
        urgencyScore: item.urgency_score,
        category: item.category,
        summary: item.summary,
        connectionId: item.connection_id,
        attachments: item.attachments || [],
        isEncrypted: item.is_encrypted || false,
        isArchived: item.is_archived || false,
        preview: item.preview ?? null,
        sourceType: item.source_type ?? null,
        sourceSystem: item.source_system ?? null,
        sourceId: item.source_id ?? null,
      }),
    );

    const results = await bulkInsertIdempotent({
      repository: this.communicationRepository,
      entities,
      primaryKey: 'id',
      getTriple: (entity) => ({
        sourceType: entity.sourceType,
        sourceSystem: entity.sourceSystem,
        sourceId: entity.sourceId,
      }),
      scope: { userId: context.userId },
      conflictTarget: '(user_id, time, source_type, source_system, source_id) WHERE source_id IS NOT NULL',
      tripleColumns: ['source_type', 'source_system', 'source_id'],
      // Self-heal source-derived mutable fields on re-sync. Communications
      // imported before the importer's direction fix landed as `inbound`; a plain
      // DO NOTHING re-sync left them wrong forever. Likewise `participants_metadata`
      // (now carrying `.to` recipients) was absent on older rows, blocking the
      // comms->people backfill from populating to_entity_ids. Refreshing these on
      // conflict corrects both while staying idempotent (no dup rows). We
      // deliberately exclude identity/arbiter columns (id, time, user_id,
      // source_*) and any column a user may edit server-side. NOTE: this means a
      // re-sync overwrites these five fields from the source of record; do not add
      // server-mutable columns here or a re-import would clobber local edits.
      conflictUpdateColumns: ['direction', 'participants_metadata', 'content', 'preview', 'subject'],
      // communications is a TimescaleDB hypertable partitioned on time; bound the
      // dedup/hydrate reads to the batch's time range so chunk exclusion avoids the
      // all-chunks scan that segfaults TSDB 2.28 (importer pushes in time order).
      timeColumn: 'time',
    });

    // Bulk ingest does NOT emit a per-row CommunicationCreatedEvent: at import
    // volume the per-row pgboss fan-out (one job per registered queue per row)
    // was the dominant cost. Search indexing for bulk-loaded rows is deferred to
    // the post-load batch embed (POST /api/maintenance/search-index/backfill).
    // Single-row create() still emits, so interactive creates index live.
    return results.map(({ entity }) => CommunicationEntity.toEgressType(entity));
  }

  async findAll(context: UserServiceContext): Promise<Communication[]> {
    const result = await this.communicationRepository.find({
      where: {
        userId: context.userId,
      },
    });

    return result.map((entity) => CommunicationEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<Communication | null> {
    const result = await this.communicationRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return result ? CommunicationEntity.toEgressType(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Communication | null)[]> {
    const result = await this.communicationRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(result.map((entity) => [entity.id, CommunicationEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async update(
    context: ServiceContext,
    id: string,
    data: UpdateCommunicationDto,
  ): Promise<Communication | null> {
    const updateData: Partial<CommunicationEntity> = {};

    console.log('update', data);

    if (data.device_id) {
      updateData.deviceId = data.device_id;
    }

    if (data.direction) {
      updateData.direction = data.direction;
    }

    if (data.thread_id) {
      updateData.threadId = data.thread_id;
    }

    if (data.from_entity_id) {
      updateData.fromEntityId = data.from_entity_id;
    }

    if (data.to_entity_ids) {
      updateData.toEntityIds = data.to_entity_ids;
    }

    if (data.participants_metadata) {
      updateData.participantsMetadata = data.participants_metadata;
    }

    if (data.subject) {
      updateData.subject = data.subject;
    }

    if (data.content) {
      updateData.content = data.content;
    }

    if (data.attachments) {
      updateData.attachments = data.attachments;
    }

    if (data.duration_seconds) {
      updateData.durationSeconds = data.duration_seconds;
    }

    if (data.sentiment_score) {
      updateData.sentimentScore = data.sentiment_score;
    }

    if (data.importance_score) {
      updateData.importanceScore = data.importance_score;
    }

    if (data.urgency_score) {
      updateData.urgencyScore = data.urgency_score;
    }

    if (data.category) {
      updateData.category = data.category;
    }

    if (data.summary) {
      updateData.summary = data.summary;
    }

    if (data.connection_id) {
      updateData.connectionId = data.connection_id;
    }

    if (data.is_encrypted) {
      updateData.isEncrypted = data.is_encrypted;
    }

    if (data.is_archived) {
      updateData.isArchived = data.is_archived;
    }

    if (data.preview !== 'undefined') {
      updateData.preview = data.preview;
    }

    const communication = await this.communicationRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    console.log('existing communnication', communication);

    if (communication) {
      Object.assign(communication, updateData);
      console.log('communication update', communication);
      await this.communicationRepository.save(communication);
    } else {
      return null;
    }

    await this.eventService.send(CommunicationUpdatedEvent, {
      communicationId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const communication = await this.communicationRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (!communication) {
      return false;
    }

    await this.communicationRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    await this.eventService.send(CommunicationRemovedEvent, {
      communicationId: id,
    });

    return true;
  }

  async findByThreadId(context: ServiceContext, threadId: string): Promise<CommunicationEntity[]> {
    return this.communicationRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        threadId: threadId,
      },
      order: { time: 'ASC' },
    });
  }

  async findByUserId(context: UserServiceContext, limit = 100): Promise<CommunicationEntity[]> {
    return this.communicationRepository.find({
      where: {
        userId: context.userId,
      },
      order: { time: 'DESC' },
      take: limit,
    });
  }

  async getEntitiesForCommunications(
    context: ServiceContext,
    options: Options,
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.dataSource
      .getRepository(CommunicationEntity)
      .createQueryBuilder('communications')
      .select(['communications.id'])
      .where('communications.user_id = :userId', { userId: context.userId });

    if (options.limit) {
      query = query.limit(options.limit);
    }

    if (options.order) {
      for (const [field, direction] of Object.entries(options.order)) {
        query = query.orderBy(`communications.${field}`, direction as 'ASC' | 'DESC');
      }

      // Deterministic tiebreak so same-timestamp rows page consistently.
      query = query.addOrderBy('communications.id', 'DESC');
    }

    // Composite keyset: page strictly past (afterTime, afterId) in (time DESC, id DESC).
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(communications.time < :afterTime OR (communications.time = :afterTime AND communications.id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    if (options.startTime) {
      query = query.andWhere('communications.time >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('communications.time <= :endTime', { endTime: options.endTime });
    }

    const results = await query.getRawMany();

    return results.map((row: { communications_id: string; type: IndexableEntity }) => ({
      id: row.communications_id,
      type: 'communication' as IndexableEntity,
    }));
  }
}
