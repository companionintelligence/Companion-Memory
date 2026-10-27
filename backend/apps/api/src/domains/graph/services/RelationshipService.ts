import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, QueryFailedError } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { PgErrorCode } from '@ci/common/constants';
import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { withoutUndefined } from '@ci/common/persistence';
import { ThreadService } from '@ci/domains/conversations';
import {
  ConceptService,
  CommunicationService,
  ContentService,
  CalendarEventService,
  changedFieldsBetween,
  GraphDeltaWriter,
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

/**
 * A `date` column as `YYYY-MM-DD`, however it arrives: TypeORM reads one back
 * as that string, and `updateRelationship` hands in the GraphQL `Date` scalar's
 * value, a Date at UTC midnight of the day.
 */
function dateOnly(value: Date | string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
}

@Injectable()
export class RelationshipService {
  constructor(
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepository: Repository<RelationshipEntity>,
    private readonly conceptService: ConceptService,
    private readonly communicationService: CommunicationService,
    private readonly contentService: ContentService,
    private readonly eventService: CalendarEventService,
    private readonly itemService: ItemService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly threadService: ThreadService,
    private readonly logger: LoggerService,
    // Change History. Optional so unit harnesses that build the service by hand
    // keep working; MemoryModule always provides it.
    @Optional() private readonly graphDeltaWriter?: GraphDeltaWriter,
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

      await this.recordDelta(entity, 'created', 'RelationshipService.create');

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
      const { id, properties, type, toNodeId, fromNodeId, ...updateData } = prepared;

      Object.assign(record, withoutUndefined(updateData));
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

    // As it was, for Change History: `record` is mutated in place below.
    const before = { ...record };

    Object.assign(record, withoutUndefined(data));

    const updatedEntity = await this.relationshipRepository.save(record);

    // This re-fetch is load-bearing, not redundant: `record` above was mutated
    // via `Object.assign`, and before withoutUndefined() guarded that call, an
    // untouched field arriving as `key: undefined` (RelationshipResolver.
    // updateRelationship builds its DTO with every key always present) clobbered
    // the in-memory entity even though save() correctly left the column alone in
    // SQL. Re-reading from the database is what kept `record`'s corruption from
    // ever reaching a caller — RelationshipType.isBidirectional is non-nullable
    // in the GraphQL schema, so returning the clobbered in-memory entity instead
    // of this fresh read would throw on the very first omitted-field update.
    // withoutUndefined() now fixes the root cause too, but removing this line
    // would still remove the only thing that caught it (see TaskService#update,
    // #2703, where the same class of bug shipped without this safety net).
    const entity = await this.findById(context, updatedEntity.id);

    // Against the re-read row, not `updatedEntity`: that still holds the DTO's
    // values (a `Date` for a date column), the re-read holds what was stored.
    if (entity) {
      await this.recordUpdate(before, entity);
    }

    return RelationshipEntity.toEgressType(entity!);
  }

  /**
   * The Change History row for a link edited in the app (`updateRelationship`):
   * what moved among its type, strength, dates and properties, with both ends so
   * both people's histories show it. Nothing when nothing moved.
   */
  private async recordUpdate(before: Relationship, after: Relationship): Promise<void> {
    const fields = (row: Relationship) => ({
      relationship_type: row.type,
      strength: row.strength,
      is_bidirectional: row.isBidirectional,
      start_date: dateOnly(row.startDate),
      end_date: dateOnly(row.endDate),
      properties: row.properties ?? {},
    });
    const changedFields = changedFieldsBetween(fields(before), fields(after), [
      'relationship_type',
      'strength',
      'is_bidirectional',
      'start_date',
      'end_date',
      'properties',
    ]);

    if (Object.keys(changedFields).length === 0) {
      return;
    }

    await this.graphDeltaWriter?.record({
      nodeType: 'relationship',
      changeType: 'updated',
      relationshipId: after.id,
      relationshipType: after.type,
      fromEntityId: after.fromNodeId,
      toEntityId: after.toNodeId,
      ownerUserId: after.userId,
      changeSource: 'RelationshipService.update',
      changedByUserId: after.userId,
      changedFields,
    });
  }

  async delete(context: ServiceContext, id: string): Promise<boolean> {
    const where = {
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    };
    const existing = this.graphDeltaWriter ? await this.relationshipRepository.findOne({ where }) : null;
    const result = await this.relationshipRepository.delete(where);
    const deleted = result.affected != null && result.affected > 0;

    if (deleted && existing) {
      await this.recordDelta(existing, 'deleted', 'RelationshipService.delete');
    }

    return deleted;
  }

  /**
   * The Change History row for a link made or removed in the app. Both people's
   * histories read it, through its from and to entity ids.
   */
  private async recordDelta(
    relationship: RelationshipEntity,
    changeType: 'created' | 'deleted',
    changeSource: string,
  ): Promise<void> {
    const side = changeType === 'created' ? 'new' : 'old';

    await this.graphDeltaWriter?.record({
      nodeType: 'relationship',
      changeType,
      relationshipId: relationship.id,
      relationshipType: relationship.type,
      fromEntityId: relationship.fromNodeId,
      toEntityId: relationship.toNodeId,
      ownerUserId: relationship.userId,
      changeSource,
      changedByUserId: relationship.userId,
      changedFields: {
        relationship_type: { [side]: relationship.type },
        from_entity_id: { [side]: relationship.fromNodeId },
        to_entity_id: { [side]: relationship.toNodeId },
        properties: { [side]: relationship.properties ?? {} },
      },
    });
  }
}
