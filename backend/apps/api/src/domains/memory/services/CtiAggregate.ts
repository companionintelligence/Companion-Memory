import {
  In,
  type DeepPartial,
  type EntityManager,
  type FindOptionsWhere,
  type ObjectLiteral,
  type Repository,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { ServiceContext } from '@ci/common/context';
import { chunkedConflictInsert, withoutUndefined } from '@ci/common/persistence';

import type { BaseEntity } from '../entities/BaseEntity';

/**
 * The transactional manager surface the aggregate needs: just class-keyed
 * repository dispatch. Declared structurally (rather than as `EntityManager`)
 * so services and specs can hand in exactly what they have.
 */
/**
 * Ids per `IN (...)` chunk in {@link CtiAggregate.fetchBaseMap}. Comfortably
 * under Postgres's 65,535 bound-parameter ceiling (one param per id here,
 * unlike an INSERT's per-column multiple), with headroom for the caller's own
 * other bound values.
 */
const FETCH_BASE_MAP_CHUNK = 10_000;

export interface RepositoryProvider {
  getRepository<T extends ObjectLiteral>(target: new () => T): Repository<T>;
}

/** The values every CTI base row is built from. */
export interface CtiBaseRowValues {
  id: string;
  userId: string | null | undefined;
  name: string | null;
  description: string | null;
}

/** An STI child of {@link BaseEntity} carrying the linked provenance pair. */
type LinkedBase = BaseEntity & { linkedTable: string | null; linkedId: string | null };

interface CtiAggregateOptions<TDetail extends ObjectLiteral & { id: string }, TBase extends LinkedBase> {
  /** Injected detail repository — transaction root and metadata source. */
  detailRepository: Repository<TDetail>;
  /** Detail entity class, for transactional manager dispatch. */
  detailEntity: new () => TDetail;
  /** STI child class of the `ci.entities` base row (carries the discriminator). */
  baseEntity: new () => TBase;
  /**
   * Injected base repository, for the batched composition reads. Optional for
   * aggregates whose egress does not compose from the base row.
   */
  baseRepository?: Repository<TBase>;
  /** `ci.entities.linked_table` provenance value ('objects', 'events', ...). */
  linkedTable: string;
  /** Builds the user-scoped detail `where` that authorizes id-addressed operations. */
  scopedWhere: (context: ServiceContext, id: string) => FindOptionsWhere<TDetail>;
  /**
   * Boolean detail column that tombstones the aggregate instead of destroying
   * it. When set, {@link remove} flips this flag rather than deleting the base
   * row, {@link restore} clears it again, and every id-addressed write
   * ({@link applyUpdate}, {@link remove}) refuses to touch an already-tombstoned
   * row. Aggregates that leave it unset keep the physical delete.
   *
   * The tombstone only governs THIS aggregate's writes — the owning service is
   * still responsible for teaching its read paths to skip flagged rows.
   */
  softDeleteFlag?: keyof TDetail & string;
}

/**
 * The shared machinery of a class-table-inheritance aggregate: ONE logical
 * entity persisted as a discriminated `ci.entities` base row plus a detail row
 * sharing the same uuid. {@link ItemService}, {@link CalendarEventService}, and
 * {@link CommunicationService} each compose an instance instead of hand-rolling
 * the split (this deliberately complements the single-repository
 * {@link EntityService} rather than subclassing it — a CTI aggregate owns two
 * repositories).
 *
 * The write helpers ({@link applyUpdate}, {@link remove}) run inside a
 * transaction and load the real before-state. Pass {@link CtiWriteHooks} to
 * record `ci.graph_deltas` in the same transaction via {@link GraphDeltaWriter}.
 * Entity-specific concerns (idempotency, label derivation, domain events) stay
 * in the composing service.
 */
export interface CtiWriteHooks<TDetail> {
  /**
   * Runs inside the write transaction after detail/base patches (update) or
   * immediately before the base-row delete (remove), so the trail shares the tx.
   */
  withinTx?: (args: { manager: EntityManager; before: TDetail; after: TDetail | null }) => Promise<void>;
}

export class CtiAggregate<TDetail extends ObjectLiteral & { id: string }, TBase extends LinkedBase> {
  constructor(private readonly options: CtiAggregateOptions<TDetail, TBase>) {}

  /** Builds the `ci.entities` half of the aggregate from the ingress values. */
  createBaseRow(manager: RepositoryProvider, values: CtiBaseRowValues): TBase {
    // The literal shape is BaseEntity + the linked pair; the STI child adds
    // nothing else settable here (the generic cast bridges that gap).
    return manager.getRepository(this.options.baseEntity).create({
      id: values.id,
      name: values.name,
      description: values.description,
      properties: {},
      userId: values.userId,
      linkedTable: this.options.linkedTable,
      linkedId: values.id,
    } as unknown as DeepPartial<TBase>);
  }

  /**
   * Chunked set-based insert of base rows inside the caller's transaction; the
   * STI child metadata emits the discriminator for every row. The caller names
   * the ON CONFLICT action (DO NOTHING for insert-only aggregates, a guarded
   * DO UPDATE where the base label must follow detail refreshes).
   */
  async insertBaseRows(manager: RepositoryProvider, rows: TBase[], onConflict: string): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    await chunkedConflictInsert(manager.getRepository(this.options.baseEntity), rows, onConflict);
  }

  /**
   * One batched fetch of base rows by shared uuid, keyed by id. Pass the
   * transactional manager to read inside a transaction; defaults to the
   * injected base repository.
   */
  async fetchBaseMap(ids: string[], manager?: RepositoryProvider): Promise<Map<string, TBase>> {
    if (ids.length === 0) {
      return new Map();
    }

    const repository = manager ? manager.getRepository(this.options.baseEntity) : this.options.baseRepository;
    if (!repository) {
      throw new Error(`No base repository configured for ${this.options.linkedTable} aggregate reads`);
    }

    // Chunked: `id IN (...)` puts one bind parameter per id, and a caller that
    // hands this every row it owns (EventResolver.events did, before it was
    // fixed to paginate) can exceed Postgres's protocol limit on bound
    // parameters. Past it, the query does not merely reject cleanly — the
    // driver desyncs mid-bind and raises "bind message has N parameter
    // formats but 0 parameters", which reads as nothing about the actual
    // cause. Verified live: 62,277 ids straight from `events(first: 3)`
    // loading its user's entire event table before paginating in memory.
    const bases: TBase[] = [];

    for (let offset = 0; offset < ids.length; offset += FETCH_BASE_MAP_CHUNK) {
      const slice = ids.slice(offset, offset + FETCH_BASE_MAP_CHUNK);
      const found = await repository.find({
        where: { id: In(slice) } as FindOptionsWhere<TBase>,
      });

      bases.push(...found);
    }

    return new Map(bases.map((base) => [base.id, base]));
  }

  /**
   * Composes egress values from detail rows plus one batched fetch of their
   * base rows (the owners of name/description), preserving input order.
   */
  async composeMany<TEgress>(
    entities: TDetail[],
    compose: (entity: TDetail, base: TBase | undefined) => TEgress,
  ): Promise<TEgress[]> {
    if (entities.length === 0) {
      return [];
    }

    const baseById = await this.fetchBaseMap(entities.map((entity) => entity.id));

    return entities.map((entity) => compose(entity, baseById.get(entity.id)));
  }

  /**
   * One transaction across both halves of the aggregate: the user-scoped
   * detail load authorizes the write, then each row takes its own fields.
   *
   * `base` may be a function: it receives the before-state merged with the
   * detail patch, so derived base values (e.g. a display label) reflect what
   * is actually being persisted. A base-only update still bumps the detail
   * row's update-date column (when it has one), so incremental consumers
   * watermarking on the detail table see the change.
   *
   * @returns the reloaded detail row, or `null` if no matching row exists.
   */
  async applyUpdate(
    context: ServiceContext,
    id: string,
    patches: {
      detail?: QueryDeepPartialEntity<TDetail>;
      base?: QueryDeepPartialEntity<TBase> | ((after: TDetail) => QueryDeepPartialEntity<TBase> | null);
    },
    hooks?: CtiWriteHooks<TDetail>,
  ): Promise<TDetail | null> {
    const where = this.liveWhere(context, id);

    return this.options.detailRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(this.options.detailEntity);

      const before = await repository.findOne({ where });
      if (!before) {
        return null;
      }

      // The scoped load above authorized the write; the statements below key
      // on the primary key alone (an UPDATE cannot express a relation-`where`).
      const byId = { id } as FindOptionsWhere<TDetail>;

      const detailPatch = patches.detail ?? {};
      const detailTouched = Object.keys(detailPatch).length > 0;
      if (detailTouched) {
        await repository.update(byId, detailPatch);
      }

      // Before-state merged with the patch — what the detail row now holds —
      // without waiting on the reload, so base derivation sees real values.
      // withoutUndefined() guards this the same way RelationshipService.update
      // and TaskService.update do (#2703, #2713): an untouched field arriving
      // as `key: undefined` must not clobber `before`'s real value here, since
      // `after` (unlike the `repository.update()` call above, which TypeORM
      // already normalizes) is built with a plain Object.assign.
      const after = Object.assign(
        Object.create(Object.getPrototypeOf(before) as object),
        before,
        withoutUndefined(detailPatch),
      ) as TDetail;

      const basePatch = typeof patches.base === 'function' ? patches.base(after) : (patches.base ?? null);
      if (basePatch && Object.keys(basePatch).length > 0) {
        await manager
          .getRepository(this.options.baseEntity)
          .update({ id } as FindOptionsWhere<TBase>, basePatch);

        // A base-only change (e.g. a rename) must keep the detail watermark
        // truthful for consumers sweeping the detail table by updated_at.
        const updateDateColumn = this.options.detailRepository.metadata?.updateDateColumn;
        if (!detailTouched && updateDateColumn) {
          await repository.update(byId, {
            [updateDateColumn.propertyName]: new Date(),
          } as unknown as QueryDeepPartialEntity<TDetail>);
        }
      }

      const reloaded = await repository.findOne({ where });
      if (hooks?.withinTx) {
        await hooks.withinTx({ manager, before, after: reloaded });
      }

      return reloaded;
    });
  }

  /**
   * Removes the aggregate as one unit.
   *
   * With {@link CtiAggregateOptions.softDeleteFlag} configured this is a
   * TOMBSTONE: the detail flag is set and both rows stay on disk, so the
   * deletion is reversible via {@link restore} and nothing that references the
   * aggregate is cascaded away. Without it the BASE row is deleted and the
   * deferred FK's ON DELETE CASCADE removes the detail in the same statement.
   *
   * Either way the user-scoped detail load authorizes the removal, and an
   * already-tombstoned aggregate is treated as absent (returns `false`).
   *
   * @returns `true` if a matching aggregate was found and removed.
   */
  async remove(context: ServiceContext, id: string, hooks?: CtiWriteHooks<TDetail>): Promise<boolean> {
    const where = this.liveWhere(context, id);

    return this.options.detailRepository.manager.transaction(async (manager) => {
      const before = await manager.getRepository(this.options.detailEntity).findOne({ where });
      if (!before) {
        return false;
      }

      if (hooks?.withinTx) {
        await hooks.withinTx({ manager, before, after: null });
      }

      const softDeleteFlag = this.options.softDeleteFlag;

      if (softDeleteFlag) {
        await manager
          .getRepository(this.options.detailEntity)
          .update({ id } as FindOptionsWhere<TDetail>, this.flagPatch(softDeleteFlag, true));
      } else {
        await manager.getRepository(this.options.baseEntity).delete({ id } as FindOptionsWhere<TBase>);
      }

      return true;
    });
  }

  /**
   * Clears a tombstone written by {@link remove}, bringing the aggregate back
   * exactly as it was. Only available to aggregates configured with
   * {@link CtiAggregateOptions.softDeleteFlag}; a physically deleted aggregate
   * has nothing to restore.
   *
   * @returns the reloaded detail row, or `null` when no tombstoned aggregate
   *   with that id is visible to the caller.
   */
  async restore(
    context: ServiceContext,
    id: string,
    hooks?: CtiWriteHooks<TDetail>,
  ): Promise<TDetail | null> {
    const softDeleteFlag = this.options.softDeleteFlag;

    if (!softDeleteFlag) {
      throw new Error('restore() requires a softDeleteFlag — this aggregate deletes physically');
    }

    const where = {
      ...this.options.scopedWhere(context, id),
      [softDeleteFlag]: true,
    } as FindOptionsWhere<TDetail>;

    return this.options.detailRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(this.options.detailEntity);

      const before = await repository.findOne({ where });
      if (!before) {
        return null;
      }

      await repository.update({ id } as FindOptionsWhere<TDetail>, this.flagPatch(softDeleteFlag, false));

      const reloaded = await repository.findOne({
        where: this.options.scopedWhere(context, id),
      });

      if (hooks?.withinTx) {
        await hooks.withinTx({ manager, before, after: reloaded });
      }

      return reloaded;
    });
  }

  /**
   * The scoped `where` narrowed to rows that are not tombstoned, so neither an
   * update nor a second delete can land on an already-removed aggregate.
   */
  private liveWhere(context: ServiceContext, id: string): FindOptionsWhere<TDetail> {
    const scoped = this.options.scopedWhere(context, id);

    if (!this.options.softDeleteFlag) {
      return scoped;
    }

    return { ...scoped, [this.options.softDeleteFlag]: false } as FindOptionsWhere<TDetail>;
  }

  /** Single-column boolean patch, typed for the detail repository's update(). */
  private flagPatch(flag: string, value: boolean): QueryDeepPartialEntity<TDetail> {
    return { [flag]: value } as unknown as QueryDeepPartialEntity<TDetail>;
  }
}
