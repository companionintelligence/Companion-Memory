import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { UserService } from '@ci/domains/user';

import { type Node, NodeEntity } from '../entities/NodeEntity';

@Injectable()
export class NodeService {
  constructor(
    @InjectRepository(NodeEntity)
    private readonly nodeRepository: Repository<NodeEntity>,
    private readonly userService: UserService,
  ) {}

  async findById(context: ServiceContext, id: string): Promise<Node | null> {
    const entity = await this.nodeRepository.findOne({
      where: {
        entityId: id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entity ? NodeEntity.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Node | null)[]> {
    const results = await this.nodeRepository.find({
      where: {
        entityId: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(results.map((entity) => [entity.entityId, NodeEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findNodeByUserId(context: ServiceContext, userId: string): Promise<Node | null> {
    // Note that we are storing a reference to the entity on a User. Therefore
    // we must obtain the user to get its entityId and then query for the node.
    //
    // There is room for optimization here. We should consider storing a node of
    // type `User` and using the user's id as the entityId.

    const user = await this.userService.findById(context, userId);

    if (user == null) {
      throw new Error('User could not be obtained');
    }

    if (user.entityId == null) {
      return null;
    }

    const entity = await this.nodeRepository.findOne({
      where: {
        entityId: user.entityId,
        entityType: 'Person',
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entity ? NodeEntity.toEgressType(entity) : null;
  }
}
