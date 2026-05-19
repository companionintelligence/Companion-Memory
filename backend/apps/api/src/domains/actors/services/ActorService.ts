import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { ActorEntity, type Actor, type ActorKind } from '../entities/ActorEntity';

@Injectable()
export class ActorService {
  constructor(
    @InjectRepository(ActorEntity)
    private readonly actorRepository: Repository<ActorEntity>,
  ) {}

  /**
   * Returns the actor with the given id, or null if it does not exist.
   */
  async findById(id: string): Promise<Actor | null> {
    const entity = await this.actorRepository.findOne({ where: { id } });

    return entity ? ActorEntity.toEgressType(entity) : null;
  }

  /**
   * Returns all actors belonging to (or representing) the given user. For a
   * single-user Hub this includes the user-kind actor plus every agent /
   * device created for them.
   */
  async findByParentUser(userId: string): Promise<Actor[]> {
    const rows = await this.actorRepository.find({
      where: [{ id: userId }, { parent_user_id: userId }],
      order: { created_at: 'DESC' },
    });

    return rows.map(ActorEntity.toEgressType);
  }

  /**
   * Create a non-user actor (agent or device) bound to a parent user.
   */
  async create(input: {
    kind: Exclude<ActorKind, 'user'>;
    parent_user_id: string;
    display_name: string;
    metadata?: Record<string, unknown>;
  }): Promise<Actor> {
    const entity = this.actorRepository.create({
      id: uuidv7(),
      kind: input.kind,
      parent_user_id: input.parent_user_id,
      display_name: input.display_name,
      metadata: input.metadata ?? {},
    });

    const saved = await this.actorRepository.save(entity);

    return ActorEntity.toEgressType(saved);
  }
}
