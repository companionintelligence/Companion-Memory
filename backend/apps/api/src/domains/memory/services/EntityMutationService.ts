import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import {
  EntityMutationEntity,
  type EntityMutationAggregateKind,
  type EntityMutationOp,
} from '../entities/EntityMutationEntity';

export interface RecordEntityMutationInput {
  userId?: string | null;
  aggregateKind: EntityMutationAggregateKind;
  aggregateId: string;
  entityType?: string | null;
  relationshipType?: string | null;
  op: EntityMutationOp;
  payload?: Record<string, unknown>;
  causation?: Record<string, unknown>;
  /** Optional transactional manager so the trail shares the domain write's tx. */
  manager?: EntityManager;
}

/**
 * Append-only writer for {@link EntityMutationEntity}. Failures are logged and
 * swallowed so a trail outage cannot roll back domain creates — the rebuild job
 * can heal gaps from spine tables later.
 */
@Injectable()
export class EntityMutationService {
  constructor(
    @InjectRepository(EntityMutationEntity)
    private readonly repository: Repository<EntityMutationEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EntityMutationService.name);
  }

  async record(input: RecordEntityMutationInput): Promise<void> {
    try {
      const repo = input.manager
        ? input.manager.getRepository(EntityMutationEntity)
        : this.repository;

      await repo.save(
        repo.create({
          id: uuidv7(),
          userId: input.userId ?? null,
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          entityType: input.entityType ?? null,
          relationshipType: input.relationshipType ?? null,
          op: input.op,
          payload: input.payload ?? {},
          causation: input.causation ?? {},
        }),
      );
    } catch (error) {
      this.logger.warn('Failed to record entity mutation', {
        aggregateId: input.aggregateId,
        op: input.op,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
