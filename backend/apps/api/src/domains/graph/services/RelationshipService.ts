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
import { isSymmetric, normalizeRelationship } from '../relationshipNormalize';
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
   * Maps a free-form relationship-type string onto the canonical RelationshipType
   * (via {@link normalizeRelationship}) and verifies it is allowed between the
   * given from/to node types per RelationshipMap. Returns null if unknown,
   * rejected (`IS`), or not permitted for the endpoint pair.
   */
  resolveType(raw: string, fromType: string, toType: string): keyof typeof RelationshipType | null {
    const normalized = normalizeRelationship(raw);

    if (normalized == null || normalized.reject) {
      return null;
    }

    let from = fromType;
    let to = toType;

    if (normalized.swapEndpoints) {
      from = toType;
      to = fromType;
    }

    const fromMap = RelationshipMap[from as keyof typeof RelationshipMap];

    if (!fromMap || !(to in fromMap)) {
      return null;
    }

    const allowed = fromMap[to as keyof typeof fromMap] as readonly RelationshipType[];

    return allowed.includes(normalized.type) ? (normalized.type as keyof typeof RelationshipType) : null;
  }

  /**
   * Canonicalise + allowlist a create/upsert DTO. Swaps endpoints for inverse
   * aliases, stamps symmetric `isBidirectional`, merges alias properties.
   */
  private prepareWrite(data: CreateRelationshipDto): CreateRelationshipDto {
    const normalized = normalizeRelationship(data.type);

    if (normalized == null) {
      throw new Error(`Unknown relationship type: ${data.type}`);
    }

    if (normalized.reject) {
      throw new Error(normalized.reject.reason);
    }

    let fromNodeId = data.fromNodeId;
    let fromNodeType = data.fromNodeType;
    let toNodeId = data.toNodeId;
    let toNodeType = data.toNodeType;

    if (normalized.swapEndpoints) {
      fromNodeId = data.toNodeId;
      fromNodeType = data.toNodeType;
      toNodeId = data.fromNodeId;
      toNodeType = data.fromNodeType;
    }

    if (!(fromNodeType in RelationshipMap)) {
      throw new Error(`Cannot create relationship from type ${fromNodeType}`);
    }

    const fromMap = RelationshipMap[fromNodeType as keyof typeof RelationshipMap];

    if (!(toNodeType in fromMap)) {
      throw new Error(`Cannot create relationship from ${fromNodeType} to ${toNodeType}`);
    }

    const allowedTypes = fromMap[toNodeType as keyof typeof fromMap] as readonly RelationshipType[];

    if (!allowedTypes.includes(normalized.type)) {
      throw new Error(
        `Cannot create relationship of type ${normalized.type} from ${fromNodeType} to ${toNodeType} ` +
          `(cell not in RelationshipMap; nearest: ${allowedTypes.slice(0, 3).join(', ') || 'none'})`,
      );
    }

    if (normalized.type === RelationshipType.ASSOCIATED_WITH) {
      this.logger.warn('ASSOCIATED_WITH used as fallback — prefer a specific matrix type', {
        fromNodeType,
        toNodeType,
        caller: 'RelationshipService',
      });
    }

    return {
      ...data,
      fromNodeId,
      fromNodeType,
      toNodeId,
      toNodeType,
      type: normalized.type as keyof typeof RelationshipType,
      isBidirectional: isSymmetric(normalized.type) ? true : (data.isBidirectional ?? false),
      properties: {
        ...(typeof data.properties === 'object' && data.properties != null ? data.properties : {}),
        ...(normalized.properties ?? {}),
      },
    };
  }

  async create(context: UserServiceContext, data: CreateRelationshipDto): Promise<Relationship | null> {
    const prepared = this.prepareWrite(data);

    const fromNode = await this.findNodeById(context, prepared.fromNodeId, prepared.fromNodeType);

    if (fromNode == null) {
      throw new Error(`Node with id ${prepared.fromNodeId} and type ${prepared.fromNodeType} not found`);
    }

    const toNode = await this.findNodeById(context, prepared.toNodeId, prepared.toNodeType);

    if (toNode == null) {
      throw new Error(`Node with id ${prepared.toNodeId} and type ${prepared.toNodeType} not found`);
    }

    const record = this.relationshipRepository.create({
      id: uuidv7(),
      ...prepared,
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
          fromNodeId: prepared.fromNodeId,
          toNodeId: prepared.toNodeId,
          type: prepared.type,
        });

        const existing = await this.relationshipRepository.findOne({
          where: {
            fromNodeId: prepared.fromNodeId,
            fromNodeType: prepared.fromNodeType,
            toNodeId: prepared.toNodeId,
            toNodeType: prepared.toNodeType,
            type: prepared.type,
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
    const prepared = this.prepareWrite(data);

    const fromNode = await this.findNodeById(context, prepared.fromNodeId, prepared.fromNodeType);

    if (fromNode == null) {
      throw new Error(`Node with id ${prepared.fromNodeId} and type ${prepared.fromNodeType} not found`);
    }

    const toNode = await this.findNodeById(context, prepared.toNodeId, prepared.toNodeType);

    if (toNode == null) {
      throw new Error(`Node with id ${prepared.toNodeId} and type ${prepared.toNodeType} not found`);
    }

    let record = await this.relationshipRepository.findOne({
      where: {
        fromNodeId: prepared.fromNodeId,
        toNodeId: prepared.toNodeId,
        type: prepared.type,
        userId: context.userId,
      },
    });

    if (record == null) {
      record = this.relationshipRepository.create({
        id: uuidv7(),
        ...prepared,
        userId: context.userId,
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, properties, type, toNodeId, fromNodeId, ...updateData } = prepared;

      Object.assign(record, updateData);
      record.isBidirectional = prepared.isBidirectional ?? record.isBidirectional;
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
