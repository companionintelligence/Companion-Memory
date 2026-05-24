import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, type FindOptionsOrder } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
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
    });

    // TODO: Build relationships using from_entity_id and to_entity_ids

    const communicationResult = await this.communicationRepository.save(communication);

    await this.eventService.send(CommunicationCreatedEvent, {
      communicationId: communicationResult.id,
    });

    return CommunicationEntity.toEgressType(communicationResult);
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
    }

    if (options.startTime) {
      query = query.andWhere('communications.time >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('communications.time >= :endTime', { endTime: options.endTime });
    }

    const results = await query.getRawMany();

    return results.map((row: { communications_id: string; type: IndexableEntity }) => ({
      id: row.communications_id,
      type: 'communication' as IndexableEntity,
    }));
  }
}
