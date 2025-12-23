import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { RelationshipEntity } from '../entities/RelationshipEntity';
import { CreateRelationshipDto, UpdateRelationshipDto } from '../types';

@Injectable()
export class RelationshipService {
  constructor(
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepository: Repository<RelationshipEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RelationshipService.name);
  }

  async findById(context: ServiceContext, relationshipId: string): Promise<RelationshipEntity | null> {
    return this.relationshipRepository.findOne({
      where: {
        relationship_id: relationshipId,
        ...(context.userId !== SYSTEM_USER && {
          owner_user_id: context.userId,
        }),
      },
    });
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(RelationshipEntity | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    const relationships = await this.relationshipRepository.find({
      where: {
        relationship_id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          owner_user_id: context.userId,
        }),
      },
    });

    const map = new Map(relationships.map((rel) => [rel.relationship_id, rel]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async create(context: UserServiceContext, data: CreateRelationshipDto): Promise<RelationshipEntity> {
    const relationship = this.relationshipRepository.create({
      relationship_id: data.id ?? uuid7(),
      owner_user_id: context.userId,
      from_entity_id: data.fromEntityId,
      to_entity_id: data.toEntityId,
      relationship_type: data.relationshipType,
      strength: data.strength ?? 1,
      properties: data.properties ?? {},
      is_bidirectional: data.isBidirectional ?? false,
      start_date: data.startDate ?? null,
      end_date: data.endDate ?? null,
      is_active: true,
    });

    return this.relationshipRepository.save(relationship);
  }

  async update(
    context: ServiceContext,
    relationshipId: string,
    data: UpdateRelationshipDto,
  ): Promise<RelationshipEntity | null> {
    const relationship = await this.findById(context, relationshipId);

    if (!relationship) {
      return null;
    }

    if (data.fromEntityId) {
      relationship.from_entity_id = data.fromEntityId;
    }

    if (data.toEntityId) {
      relationship.to_entity_id = data.toEntityId;
    }

    if (data.relationshipType) {
      relationship.relationship_type = data.relationshipType;
    }

    if (data.properties) {
      relationship.properties =
        data.mergeProperties === false ? data.properties : { ...relationship.properties, ...data.properties };
    }

    if (data.strength !== undefined) {
      relationship.strength = data.strength;
    }

    if (data.isBidirectional !== undefined) {
      relationship.is_bidirectional = data.isBidirectional;
    }

    if (data.startDate !== undefined) {
      relationship.start_date = data.startDate;
    }

    if (data.endDate !== undefined) {
      relationship.end_date = data.endDate;
    }

    return this.relationshipRepository.save(relationship);
  }

  async remove(context: ServiceContext, relationshipId: string): Promise<boolean> {
    const result = await this.relationshipRepository.update(
      {
        relationship_id: relationshipId,
        ...(context.userId !== SYSTEM_USER && {
          owner_user_id: context.userId,
        }),
      },
      { is_active: false },
    );

    return (result.affected ?? 0) > 0;
  }
}
