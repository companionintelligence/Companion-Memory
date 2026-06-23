import { In, type FindOptionsWhere, type ObjectLiteral, type Repository } from 'typeorm';

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
 * The memory domain persists every entity type in the single `ci.entities`
 * table via TypeORM single-table inheritance (discriminated by the `entity_type`
 * column). Because `repository` is a concrete child repository, TypeORM
 * automatically scopes every query to this entity's discriminator value — so
 * `findAll` does not need to filter by type itself. The primary-key property
 * name is resolved dynamically from TypeORM metadata rather than hardcoded. All
 * reads and the delete are additionally scoped to the caller's user, except for
 * {@link SYSTEM_USER} which is unscoped.
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
   * Deletes an entity after first loading it (user-scoped) so that TypeORM
   * lifecycle subscribers fire. `repository.remove(entity)` runs subscribers,
   * whereas `repository.delete(criteria)` bypasses them.
   *
   * @returns `true` if a matching entity was found and removed, `false` otherwise.
   */
  async delete(context: ServiceContext, id: string): Promise<boolean> {
    const where: Record<string, unknown> = {
      [this.primaryKey]: id,
      ...this.scopeToUser(context),
    };

    const entity = await this.repository.findOne({ where: where as FindOptionsWhere<E> });

    if (!entity) {
      return false;
    }

    await this.repository.remove(entity);

    return true;
  }
}
