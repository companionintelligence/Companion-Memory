import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext } from '@ci/common/context';

import { type Embedding, EmbeddingEntity } from '../entities/EmbeddingEntity';
import { UpsertEmbeddingDto, RemoveEmbeddingDto } from '../types';

@Injectable()
export class EmbeddingService {
  constructor(
    @InjectRepository(EmbeddingEntity)
    private readonly embeddingRepo: Repository<EmbeddingEntity>,
  ) {}

  async upsert(context: UserServiceContext, data: UpsertEmbeddingDto): Promise<Embedding | null> {
    return this.embeddingRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(EmbeddingEntity);

      const existing = await repo.findOne({
        where: {
          entityType: data.entityType,
          entityId: data.entityId,
          userId: context.userId,
        },
      });

      if (existing == null) {
        const instance = repo.create({
          id: uuidv7(),
          entityType: data.entityType,
          entityId: data.entityId,
          embedding: data.embedding,
          userId: context.userId,
        });

        const entity = await repo.save(instance);

        return EmbeddingEntity.toEgressType(entity);
      }

      await repo.update(
        {
          id: existing.id,
        },
        {
          embedding: data.embedding,
        },
      );

      const updated = await repo.findOne({
        where: {
          id: existing.id,
        },
      });

      return updated ? EmbeddingEntity.toEgressType(updated) : null;
    });
  }

  async remove(context: ServiceContext, data: RemoveEmbeddingDto): Promise<boolean> {
    const result = await this.embeddingRepo.delete({
      entityType: data.entityType,
      entityId: data.entityId,
    });

    return result.affected ? result.affected > 0 : false;
  }
}
