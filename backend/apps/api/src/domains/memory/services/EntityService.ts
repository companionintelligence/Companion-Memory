import { In, type EntityManager, type FindOptionsWhere, type ObjectLiteral, type Repository } from 'typeorm';

import { type ServiceContext, SYSTEM_USER } from '@ci/common/context';

/**
 * Structural contract for an entity class that knows how to map one of its
 * persisted instances into its egress (domain) representation.
 *
 * This is enforced at compile time: any class handed to {@link EntityService}
 * via `super()` must expose a static `toEgressType(entity: E): T`, which keeps
 * the mapping convention consistent with the rest of the memory domain (e.g.
 * `PersonEntity.toEgressType`).
 */
export interface EgressMapper<E, T> {
  toEgressType(entity: E): T;
}

/**
 * Generic base service for the memory domain's entity services.
 *
 * - `E` is the TypeORM entity.
 * - `T` is the egress/domain model produced by the entity's static
 *   `toEgressType`.
 *
 * Reads are user-scoped (the {@link SYSTEM_USER} is unscoped) and the primary
 * key is resolved from TypeORM metadata rather than hardcoded.
 *
 * The write helpers ({@link delete}, {@link applyUpdate}, {@link persistCreate})
 * run inside a transaction and load real before/after states. They are also the
 * seam where service-boundary mutation recording will plug in; each helper is
 * one `record()` call away from an audited write path. Entity-specific concerns
 * (idempotency, domain events) stay in the subclass, which composes these
 * helpers.
 */
export abstract class EntityService<E extends ObjectLiteral, T> {
  protected constructor(
    protected readonly repository: Repository<E>,
    protected readonly entityClass: EgressMapper<E, T>,
  ) {}

  /**
   * Name of the entity's primary-key property, resolved from TypeORM metadata.
   */
  protected get primaryKey(): string {
    return this.repository.metadata.primaryColumns[0].propertyName;
  }

  /**
   * Partial `where` clause constraining a query to the caller's user. The
   * system user is unscoped and sees every record.
   */
  protected scopeToUser(context: ServiceContext): Record<string, unknown> {
    if (context.userId === SYSTEM_USER) {
      return {};
    }

    return {
      userId: context.userId,
    };
  }

  async findAll(context: ServiceContext): Promise<T[]> {
    const where = this.scopeToUser(context);

    const entities = await this.repository.find({ where: where as FindOptionsWhere<E> });

    return entities.map((entity) => this.entityClass.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<T | null> {
    const where: Record<string, unknown> = {
      [this.primaryKey]: id,
      ...this.scopeToUser(context),
    };

    const entity = await this.repository.findOne({ where: where as FindOptionsWhere<E> });

    return entity ? this.entityClass.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(T | null)[]> {
    const pk = this.primaryKey;

    const where: Record<string, unknown> = {
      [pk]: In(ids),
      ...this.scopeToUser(context),
    };

    const entities = await this.repository.find({ where: where as FindOptionsWhere<E> });

    const map = new Map<unknown, T>(
      entities.map((entity) => [
        (entity as Record<string, unknown>)[pk],
        this.entityClass.toEgressType(entity),
      ]),
    );

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Saves a new entity on the supplied transactional manager. The caller owns
   * the surrounding transaction so it can compose this with idempotency checks
   * or other writes.
   */
  protected async persistCreate(manager: EntityManager, instance: E): Promise<E> {
    const repository = manager.getRepository<E>(this.repository.target);

    return repository.save(instance);
  }

  /**
   * Loads the user-scoped entity, applies a partial update, and reloads it —
   * all in one transaction, so the caller gets the real persisted after-state
   * (DB defaults applied, @AfterLoad fired).
   *
   * `patch` may be a function: it receives the loaded before-state and returns
   * the partial update, letting subclasses derive the patch from what is
   * actually stored (e.g. merging a properties bag) without a second read. The
   * before-load is also the seam where mutation recording will observe the
   * prior state (see the class doc).
   *
   * @returns the updated entity, or `null` if no matching entity exists.
   */
  protected async applyUpdate(
    context: ServiceContext,
    id: string,
    patch: Parameters<Repository<E>['update']>[1] | ((before: E) => Parameters<Repository<E>['update']>[1]),
  ): Promise<E | null> {
    const where: Record<string, unknown> = {
      [this.primaryKey]: id,
      ...this.scopeToUser(context),
    };

    return this.repository.manager.transaction(async (manager) => {
      const repository = manager.getRepository<E>(this.repository.target);

      const before = await repository.findOne({ where: where as FindOptionsWhere<E> });
      if (!before) {
        return null;
      }

      const resolved = typeof patch === 'function' ? patch(before) : patch;

      await repository.update(where as FindOptionsWhere<E>, resolved);

      return repository.findOne({ where: where as FindOptionsWhere<E> });
    });
  }

  /**
   * Deletes a user-scoped entity. Loads first so `remove` (not `delete`) runs —
   * keeping TypeORM lifecycle subscribers firing and giving the caller a place
   * to observe the prior state.
   *
   * @returns `true` if a matching entity was found and removed, `false` otherwise.
   */
  async delete(context: ServiceContext, id: string): Promise<boolean> {
    const where: Record<string, unknown> = {
      [this.primaryKey]: id,
      ...this.scopeToUser(context),
    };

    return this.repository.manager.transaction(async (manager) => {
      const repository = manager.getRepository<E>(this.repository.target);

      const before = await repository.findOne({ where: where as FindOptionsWhere<E> });
      if (!before) {
        return false;
      }

      await repository.remove(before);

      return true;
    });
  }
}
