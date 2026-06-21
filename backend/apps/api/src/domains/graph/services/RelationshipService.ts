import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, QueryFailedError } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { PgErrorCode } from '@ci/common/constants';
import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ThreadService } from '@ci/domains/conversations';
import {
  ConceptService,
  CommunicationService,
  ContentService,
  EventService,
  ItemService,
  PersonService,
  PlaceService,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';

import { type Relationship, RelationshipEntity } from '../entities/RelationshipEntity';
import {
  type CreateRelationshipDto,
  type UpdateRelationshipDto,
  RelationshipType,
  RelationshipMap,
} from '../types';

@Injectable()
export class RelationshipService {
  constructor(
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepository: Repository<RelationshipEntity>,
    private readonly conceptService: ConceptService,
    private readonly communicationService: CommunicationService,
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly threadService: ThreadService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RelationshipService.name);
  }

  private async findNodeById(
    context: ServiceContext,
    nodeId: string,
    nodeType: string,
  ): Promise<unknown | null> {
    switch (nodeType) {
      case 'concept':
        return await this.conceptService.findById(context, nodeId);
      case 'communication':
        return await this.communicationService.findById(context, nodeId);
      case 'content':
        return await this.contentService.findById(context, nodeId);
      case 'event':
        return await this.eventService.findById(context, nodeId);
      case 'item':
        return await this.itemService.findById(context, nodeId);
      case 'note':
        return await this.noteService.findById(context, nodeId);
      case 'person':
        return await this.personService.findById(context, nodeId);
      case 'place':
        return await this.placeService.findById(context, nodeId);
      case 'thread':
        return await this.threadService.findById(context, nodeId);
      default:
        throw new Error(`Unknown node type: ${nodeType}`);
    }
  }

  /**
   * Maps a free-form relationship-type string onto the RelationshipType enum
   * and verifies the resulting type is allowed between the given from/to node
   * types per RelationshipMap. Returns null if the type is unknown or not
   * permitted for the endpoint pair.
   */
  resolveType(raw: string, fromType: string, toType: string): keyof typeof RelationshipType | null {
    const key = raw.trim().toUpperCase() as keyof typeof RelationshipType;

    if (!(key in RelationshipType)) {
      return null;
    }

    const fromMap = RelationshipMap[fromType as keyof typeof RelationshipMap];

    if (!fromMap || !(toType in fromMap)) {
      return null;
    }

    const allowed = fromMap[toType as keyof typeof fromMap] as readonly RelationshipType[];

    return allowed.includes(RelationshipType[key]) ? key : null;
  }

  async create(context: UserServiceContext, data: CreateRelationshipDto): Promise<Relationship | null> {
    const fromNode = await this.findNodeById(context, data.fromNodeId, data.fromNodeType);

    if (fromNode == null) {
      throw new Error(`Node with id ${data.fromNodeId} and type ${data.fromNodeType} not found`);
    }

    const toNode = await this.findNodeById(context, data.toNodeId, data.toNodeType);

    if (toNode == null) {
      throw new Error(`Node with id ${data.toNodeId} and type ${data.toNodeType} not found`);
    }

    if (!(data.fromNodeType in RelationshipMap)) {
      throw new Error(`Cannot create relationship from type ${data.fromNodeType}`);
    }

    const fromMap = RelationshipMap[data.fromNodeType as keyof typeof RelationshipMap];

    if (!(data.toNodeType in fromMap)) {
      throw new Error(`Cannot create relationship from ${data.fromNodeType} to ${data.toNodeType}`);
    }

    const allowedTypes = fromMap[data.toNodeType as keyof typeof fromMap];

    if (!allowedTypes.includes(data.type as RelationshipType)) {
      throw new Error(
        `Cannot create relationship of type ${data.type} from ${data.fromNodeType} to ${data.toNodeType}`,
      );
    }

    const record = this.relationshipRepository.create({
      id: uuidv7(),
      ...data,
      userId: context.userId,
    });

    try {
      const entity = await this.relationshipRepository.save(record);

      return RelationshipEntity.toEgressType(entity);
    } catch (err: unknown) {
      // There is a uniqueness constraint on relationships to prevent duplicates
      // But it may be too narrowly-defined, as it's only a combination of
      // to/from/type, and we may want to expand that to include the start/end
      // dates. For now, try to find the existing relationship and return it if
      // we hit a duplicate key error.
      if (err instanceof QueryFailedError && err.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        this.logger.log('Attempted to create duplicate relationship', {
          fromNodeId: data.fromNodeId,
          toNodeId: data.toNodeId,
          type: data.type,
        });

        const existing = await this.relationshipRepository.findOne({
          where: {
            fromNodeId: data.fromNodeId,
            fromNodeType: data.fromNodeType,
            toNodeId: data.toNodeId,
            toNodeType: data.toNodeType,
            type: data.type,
            userId: context.userId,
          },
        });

        return existing ? RelationshipEntity.toEgressType(existing) : null;
      } else {
        throw err;
      }
    }
  }

  // There are some relationships where multiple identical relationships should
  // not exist. For example, a user should not have multiple "FRIENDS_WITH"
  // relationships to the same person. This upsert method checks for existing
  // relationships by type, and start and end node ids before creating a new
  // one.
  //
  // Note that there are some cases where a start date should only be updated if
  // the new date is earlier than the existing one, or an end date should only
  // be updated if the new date is later than the existing one. This logic is
  // not implemented here, but could be added in the future if needed. E.g. is
  // discovering friends from different social media sources.
  async upsert(context: UserServiceContext, data: CreateRelationshipDto): Promise<Relationship> {
    const fromNode = await this.findNodeById(context, data.fromNodeId, data.fromNodeType);

    if (fromNode == null) {
      throw new Error(`Node with id ${data.fromNodeId} and type ${data.fromNodeType} not found`);
    }

    const toNode = await this.findNodeById(context, data.toNodeId, data.toNodeType);

    if (toNode == null) {
      throw new Error(`Node with id ${data.toNodeId} and type ${data.toNodeType} not found`);
    }

    let record = await this.relationshipRepository.findOne({
      where: {
        fromNodeId: data.fromNodeId,
        toNodeId: data.toNodeId,
        type: data.type,
        userId: context.userId,
      },
    });

    if (record == null) {
      record = this.relationshipRepository.create({
        id: uuidv7(),
        ...data,
        userId: context.userId,
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, properties, type, toNodeId, fromNodeId, ...updateData } = data;

      Object.assign(record, updateData);

      // TODO: Merge properties instead of ignoring them.
    }

    const entity = await this.relationshipRepository.save(record);

    return RelationshipEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<Relationship[]> {
    const entities = await this.relationshipRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entities.map((entity) => RelationshipEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<Relationship | null> {
    const entity = await this.relationshipRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entity ? RelationshipEntity.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Relationship | null)[]> {
    const results = await this.relationshipRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(results.map((entity) => [entity.id, RelationshipEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async update(
    context: ServiceContext,
    id: string,
    data: UpdateRelationshipDto,
  ): Promise<Relationship | null> {
    const record = await this.relationshipRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (record == null) {
      return null;
    }

    Object.assign(record, data);

    const updatedEntity = await this.relationshipRepository.save(record);

    const entity = await this.findById(context, updatedEntity.id);

    return RelationshipEntity.toEgressType(entity!);
  }

  async delete(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.relationshipRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    return result.affected != null && result.affected > 0;
  }
}
