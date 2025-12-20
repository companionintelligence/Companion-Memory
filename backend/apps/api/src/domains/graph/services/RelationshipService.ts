import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';

import { type Relationship, RelationshipEntity } from '../entities/RelationshipEntity';
import type { CreateRelationshipDto, UpdateRelationshipDto } from '../types';

import { NodeService } from './NodeService';

@Injectable()
export class RelationshipService {
  constructor(
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepository: Repository<RelationshipEntity>,
    private readonly nodeService: NodeService,
  ) {}

  async create(context: UserServiceContext, data: CreateRelationshipDto): Promise<Relationship> {
    const [fromNode, toNode] = await this.nodeService.findByIds(context, [data.fromNodeId, data.toNodeId]);

    if (fromNode == null) {
      throw new Error(`Node with id ${data.fromNodeId} not found`);
    }

    if (toNode == null) {
      throw new Error(`Node with id ${data.toNodeId} not found`);
    }

    const record = this.relationshipRepository.create({
      id: uuidv7(),
      ...data,
      userId: context.userId,
    });

    const entity = await this.relationshipRepository.save(record);

    return RelationshipEntity.toEgressType(entity);
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

    return RelationshipEntity.toEgressType(updatedEntity);
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
