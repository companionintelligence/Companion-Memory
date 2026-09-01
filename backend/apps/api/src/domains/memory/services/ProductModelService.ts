import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, IsNull, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type BulkInsertResult, bulkInsertIdempotent, computeChunkSize } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { ObjectIdentifierService } from '@ci/domains/graph/services/ObjectIdentifierService';
import type { ObjectIdentifierNamespace } from '@ci/domains/graph/utils/normalizeObjectIdentifier';
import { ProductUpdatedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type ProductModel, ProductModelEntity } from '../entities/ProductModelEntity';
import type { CreateProductModelDto, FindProductModelsFilter, UpdateProductModelDto } from '../types';

/**
 * The `product_models_brand_model_uniq` predicate, VERBATIM.
 *
 * Postgres infers a partial unique index for an `ON CONFLICT` only when both
 * the index expression list and the predicate match what the index was created
 * with. Getting either half wrong does not fail loudly — it raises
 * "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification" at runtime, which is a 500 on a path whose whole job is to be
 * safe under concurrency. Kept as one constant so the two statements that need
 * it cannot drift.
 *
 * @see backend/apps/api/db/postgres/migrations/20260803223013_create_product_models.sql
 */
const BRAND_MODEL_CONFLICT_TARGET =
  '(owner_user_id, lower(btrim(brand)), lower(btrim(model_number))) ' +
  'WHERE brand IS NOT NULL AND model_number IS NOT NULL AND merged_into_product_id IS NULL';

/** The index name Postgres reports in the 23505 raised by {@link BRAND_MODEL_CONFLICT_TARGET}. */
const BRAND_MODEL_CONSTRAINT = 'product_models_brand_model_uniq';

/** The `product_models_source_identity_uniq` arbiter, same shape as every other ci.* ingest table. */
const SOURCE_IDENTITY_CONFLICT_TARGET =
  '(owner_user_id, source_system, source_id) WHERE source_id IS NOT NULL';

/**
 * Was this a violation of the brand+model uniqueness index?
 *
 * Checked BY NAME rather than on the bare SQLSTATE, because `ci.product_models`
 * carries a second unique index (`product_models_source_identity_uniq`) and
 * reporting "some unique constraint broke" as "that brand and model number are
 * already taken" would be a lie that survives every test.
 *
 * The constraint name is accepted as absent: node-postgres fills it from the
 * server's error fields and a pooler in between is not required to forward
 * them. That is safe on the one path this guards — {@link
 * ProductModelService.update} writes none of `source_type`/`source_system`/
 * `source_id`, so the source-triple index cannot be the one that fired. A 23505
 * naming any OTHER constraint is rethrown untouched.
 */
function isBrandModelConflict(err: unknown): boolean {
  const candidate = err as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
  } | null;

  if ((candidate?.driverError?.code ?? candidate?.code) !== '23505') {
    return false;
  }

  const constraint = candidate?.driverError?.constraint ?? candidate?.constraint;

  return constraint == null || constraint === BRAND_MODEL_CONSTRAINT;
}

/**
 * Identity confidence for a model minted from a brand+model pair nobody
 * verified.
 *
 * Below the 1.0 default on purpose: 1.0 means "user-entered or barcode-scanned"
 * and is read as ground truth by HBPE and RAG, and a model conjured from two
 * strings on a receipt line is not that. Matches the tier the migration's
 * column comment names for receipt-derived rows.
 */
export const FIND_OR_CREATE_IDENTITY_CONFIDENCE = 0.7;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The row shape written by the raw-SQL find-or-create. */
interface ProductIdRow {
  product_id: string;
}

/**
 * Read/write surface for `ci.product_models` — the CATALOG half of the
 * product/instance split.
 *
 * `ci.objects` holds the owned UNITS ("the iPhone on my desk, serial F2LX…,
 * cracked screen"); this holds what those units are instances of ("iPhone 15
 * Pro 256GB Blue Titanium"). Before the table existed, buying three of the same
 * headphones produced three unrelated object rows with the brand/model
 * strings duplicated three times and nowhere to hang the canonical barcode,
 * spec sheet, MSRP or manual.
 *
 * ── The one rule ───────────────────────────────────────────────────────────
 *
 * EVERY READ FILTERS `merged_into_product_id IS NULL`.
 *
 * A tombstoned model is a row that LOST a merge; its data has already been
 * folded into the survivor. Returning one is not a stale read, it is a wrong
 * answer — the caller gets a product that nothing points at any more, mints
 * objects against it, and re-creates the duplicate the merge just removed.
 * The filter lives in {@link liveScope} so no read path can forget it.
 */
@Injectable()
export class ProductModelService {
  constructor(
    @InjectRepository(ProductModelEntity)
    private readonly repository: Repository<ProductModelEntity>,
    private readonly objectIdentifierService: ObjectIdentifierService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ProductModelService.name);
  }

  /**
   * The user scope plus the tombstone filter — the `where` fragment EVERY read
   * in this class starts from. See the class docblock.
   */
  private liveScope(context: ServiceContext) {
    return {
      ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      mergedIntoProductId: IsNull(),
    };
  }

  /**
   * `identity_confidence` is CHECKed `> 0 AND <= 1`. Rejecting an out-of-range
   * value here turns a constraint violation from inside a transaction into a
   * 400 the caller can act on.
   */
  private validConfidence(value: number | undefined): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!(value > 0 && value <= 1)) {
      throw new BadRequestException(`identityConfidence must be greater than 0 and at most 1 (got ${value})`);
    }

    return value;
  }

  /**
   * The column set shared by `create` and `createMany`, so a field can never be
   * honoured on one path and dropped on the other.
   */
  private toEntity(context: UserServiceContext, dto: CreateProductModelDto): ProductModelEntity {
    const confidence = this.validConfidence(dto.identityConfidence);

    return this.repository.create({
      id: dto.id ?? uuid7(),
      userId: context.userId,
      ownerUserId: context.userId,
      productEntityId: dto.productEntityId ?? null,
      title: dto.title,
      brand: dto.brand ?? null,
      manufacturer: dto.manufacturer ?? null,
      modelNumber: dto.modelNumber ?? null,
      category: dto.category ?? null,
      subcategory: dto.subcategory ?? null,
      productType: dto.productType ?? null,
      description: dto.description ?? null,
      variantAttributes: dto.variantAttributes ?? {},
      spec: dto.spec ?? {},
      msrpMinor: dto.msrpMinor ?? null,
      currency: dto.currency ?? null,
      imageContentId: dto.imageContentId ?? null,
      manualContentIds: dto.manualContentIds ?? null,
      isDigital: dto.isDigital ?? false,
      ...(confidence !== undefined && { identityConfidence: confidence }),
      metadata: dto.metadata ?? {},
      sourceType: dto.sourceType ?? null,
      sourceSystem: dto.sourceSystem ?? null,
      sourceId: dto.sourceId ?? null,
    });
  }

  async create(context: UserServiceContext, dto: CreateProductModelDto): Promise<ProductModel> {
    return this.repository.save(this.toEntity(context, dto));
  }

  /** Batch ingest, idempotent on the provenance triple. */
  async createMany(context: UserServiceContext, dtos: CreateProductModelDto[]): Promise<ProductModel[]> {
    return (await this.createManyDetailed(context, dtos)).map(({ entity }) => entity);
  }

  /**
   * Same ingest as {@link createMany}, reporting which rows this call actually
   * INSERTED rather than found already present — the importer needs the
   * difference, or a push that was almost entirely repeats reports itself as
   * all new work.
   */
  async createManyDetailed(
    context: UserServiceContext,
    dtos: CreateProductModelDto[],
  ): Promise<Array<BulkInsertResult<ProductModel>>> {
    if (dtos.length === 0) {
      return [];
    }

    return bulkInsertIdempotent({
      repository: this.repository,
      entities: dtos.map((dto) => this.toEntity(context, dto)),
      primaryKey: 'id',
      getTriple: (entity) => ({
        sourceType: entity.sourceType,
        sourceSystem: entity.sourceSystem,
        sourceId: entity.sourceId,
      }),
      scope: { ownerUserId: context.userId },
      conflictTarget: SOURCE_IDENTITY_CONFLICT_TARGET,
      identityColumns: ['source_system', 'source_id'],
      sourceLedger: { table: 'product_models', userId: context.userId, importRunId: context.importRunId ?? null },
    });
  }

  async findById(context: ServiceContext, id: string, manager?: EntityManager): Promise<ProductModel | null> {
    const repository = manager ? manager.withRepository(this.repository) : this.repository;

    return repository.findOne({ where: { id, ...this.liveScope(context) } });
  }

  /** Batched read, preserving input order and holding `null` for misses. */
  async findByIds(context: ServiceContext, ids: string[]): Promise<Array<ProductModel | null>> {
    if (ids.length === 0) {
      return [];
    }

    const unique = [...new Set(ids)];
    const found: ProductModelEntity[] = [];
    // One bind parameter per id, so the IN-list is chunked like every other
    // batched read in this domain.
    const chunkSize = computeChunkSize(1);

    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const slice = unique.slice(offset, offset + chunkSize);
      const qb = this.repository
        .createQueryBuilder('product')
        .where('product.product_id IN (:...ids)', { ids: slice })
        .andWhere('product.merged_into_product_id IS NULL');

      if (context.userId !== SYSTEM_USER) {
        qb.andWhere('product.user_id = :userId', { userId: context.userId });
      }

      found.push(...(await qb.getMany()));
    }

    const byId = new Map(found.map((row) => [row.id, row]));

    return ids.map((id) => byId.get(id) ?? null);
  }

  /**
   * Identifiers for the explorer's browse, newest first.
   *
   * A product model has no domain timestamp at all — `created_at` is when the
   * catalog row was written, never when anything happened — so this type is a
   * member of `SearchResolver.BROWSE_OPT_IN_TYPES`: it is merged into the feed
   * only when the caller NAMES it (the What picker's "Products"), and a browse
   * restricted to catalog models is honestly ordered by when each model was
   * learned about. The ordering matches `product_models_user_idx`
   * `(user_id, created_at DESC)`.
   *
   * Mirrors {@link ItemService.getEntitiesForItems}, including the tombstone
   * filter: a model that lost a merge must not come back in the feed.
   */
  async getEntitiesForProducts(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.repository
      .createQueryBuilder('product')
      .select('product.product_id', 'id')
      .where('product.user_id = :userId', { userId: context.userId })
      .andWhere('product.merged_into_product_id IS NULL');

    if (options.startTime) {
      query = query.andWhere('product.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('product.created_at <= :endTime', { endTime: options.endTime });
    }

    // Composite keyset: page strictly past (afterTime, afterId) in
    // (created_at DESC, product_id DESC) — see ItemService.getEntitiesForItems.
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(product.created_at < :afterTime OR (product.created_at = :afterTime AND product.product_id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    query = query
      .orderBy('product.created_at', options.order ?? 'DESC')
      .addOrderBy('product.product_id', 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'product' as IndexableEntity }));
  }

  /**
   * True total behind {@link getEntitiesForProducts} — the same predicates minus
   * the pagination-only ones, as a real `COUNT(*)`. See
   * ItemService.countEntitiesForItems for why the page length will not do.
   */
  async countEntitiesForProducts(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date } = {},
  ): Promise<number> {
    let query = this.repository
      .createQueryBuilder('product')
      .where('product.user_id = :userId', { userId: context.userId })
      // Same predicate as getEntitiesForProducts, or the count disagrees with
      // the page it is supposed to describe.
      .andWhere('product.merged_into_product_id IS NULL');

    if (options.startTime) {
      query = query.andWhere('product.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('product.created_at <= :endTime', { endTime: options.endTime });
    }

    return query.getCount();
  }

  /** Every live model for the user, newest first. */
  async findAll(context: ServiceContext): Promise<ProductModel[]> {
    return this.find(context);
  }

  /** Scoped read. Every filter is optional; the default is "this user's live models, newest first". */
  async find(context: ServiceContext, filter: FindProductModelsFilter = {}): Promise<ProductModel[]> {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(filter.offset ?? 0, 0);

    const qb = this.repository
      .createQueryBuilder('product')
      .where('product.merged_into_product_id IS NULL')
      .orderBy('product.created_at', 'DESC')
      .addOrderBy('product.product_id', 'DESC')
      .limit(limit)
      .offset(offset);

    if (context.userId !== SYSTEM_USER) {
      qb.andWhere('product.user_id = :userId', { userId: context.userId });
    }

    if (filter.brand != null) {
      // Matches product_models_brand_idx, which is on lower(btrim(brand)).
      qb.andWhere('lower(btrim(product.brand)) = lower(btrim(:brand))', { brand: filter.brand });
    }

    if (filter.category != null) {
      qb.andWhere('product.category = :category', { category: filter.category });
    }

    if (filter.subcategory != null) {
      qb.andWhere('product.subcategory = :subcategory', { subcategory: filter.subcategory });
    }

    if (filter.productType != null) {
      qb.andWhere('product.product_type = :productType', { productType: filter.productType });
    }

    if (filter.isDigital != null) {
      qb.andWhere('product.is_digital = :isDigital', { isDigital: filter.isDigital });
    }

    if (filter.titleContains != null && filter.titleContains.trim() !== '') {
      qb.andWhere('product.title ILIKE :titleContains', {
        titleContains: `%${filter.titleContains.trim()}%`,
      });
    }

    return qb.getMany();
  }

  /**
   * Patch a live model. Absent keys are left alone; an explicit `null` clears.
   *
   * Refuses to target a tombstone: writing to the losing side of a merge puts
   * data somewhere nothing reads.
   *
   * ── The conflict this can raise, and why it is a 409 ───────────────────────
   *
   * `brand` and `model_number` are both patchable and both sit in
   * `product_models_brand_model_uniq`, so renaming a model onto a pair another
   * LIVE model already holds raises 23505 — a caller-caused conflict, not a
   * server fault. Left unhandled it surfaces as a 500 with a Postgres string in
   * it, which tells the caller neither what happened nor what to do. It is
   * translated here rather than pre-checked with a SELECT, because a SELECT
   * cannot be authoritative: two renames onto the same pair both see it free.
   * The index arbitrates; this only reports what it decided. That is the same
   * reason {@link validConfidence} pre-validates the CHECK it CAN evaluate
   * locally, and this one does not.
   */
  async update(
    context: ServiceContext,
    id: string,
    dto: UpdateProductModelDto,
  ): Promise<ProductModel | null> {
    const existing = await this.findById(context, id);

    if (existing == null) {
      return null;
    }

    const patch: Partial<ProductModelEntity> = {};
    const assign = <K extends keyof ProductModelEntity>(key: K, value: ProductModelEntity[K] | undefined) => {
      if (value !== undefined) {
        patch[key] = value;
      }
    };

    assign('title', dto.title);
    assign('brand', dto.brand);
    assign('manufacturer', dto.manufacturer);
    assign('modelNumber', dto.modelNumber);
    assign('category', dto.category);
    assign('subcategory', dto.subcategory);
    assign('productType', dto.productType);
    assign('description', dto.description);
    assign('variantAttributes', dto.variantAttributes);
    assign('spec', dto.spec);
    assign('msrpMinor', dto.msrpMinor);
    assign('currency', dto.currency);
    assign('imageContentId', dto.imageContentId);
    assign('manualContentIds', dto.manualContentIds);
    assign('isDigital', dto.isDigital);
    assign('productEntityId', dto.productEntityId);
    assign('metadata', dto.metadata);
    assign('identityConfidence', this.validConfidence(dto.identityConfidence));

    if (Object.keys(patch).length === 0) {
      return existing;
    }

    // TypeORM's update builder types a jsonb `Record<string, unknown>` column as
    // a deep-partial it cannot accept; the same cast ItemService.update carries.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writable = patch as any;

    try {
      await this.repository.update({ id, ...this.liveScope(context) }, writable);
    } catch (err) {
      if (!isBrandModelConflict(err)) {
        throw err;
      }

      const brand = dto.brand !== undefined ? dto.brand : existing.brand;
      const modelNumber = dto.modelNumber !== undefined ? dto.modelNumber : existing.modelNumber;

      throw new ConflictException(
        `Another product model already claims brand "${brand}" with model number "${modelNumber}"`,
      );
    }

    await this.eventService.send(ProductUpdatedEvent, { productId: id });

    return this.findById(context, id);
  }

  /**
   * Find the live model for a (brand, modelNumber) pair, creating it if nobody
   * has yet.
   *
   * ── Why an INSERT and not a SELECT-then-INSERT ─────────────────────────────
   *
   * Two receipt extractions running at once both see "no such model" and both
   * insert; one wins the unique index and the other raises 23505 mid-transaction,
   * aborting a whole receipt because two lines mentioned the same product. The
   * INSERT-first shape lets Postgres arbitrate: `DO NOTHING` makes the loser a
   * no-op, and the SELECT that follows returns whichever row won.
   *
   * The conflict target repeats `product_models_brand_model_uniq`'s predicate
   * VERBATIM ({@link BRAND_MODEL_CONFLICT_TARGET}) — a partial index is only
   * inferred when the predicate matches, and a mismatch is a runtime 500, not a
   * compile error.
   *
   * Returns `null` when brand or modelNumber is missing: the index does not
   * cover those rows, so there is no key to find-or-create ON, and inserting
   * anyway would mint an unbounded number of unfindable models.
   */
  async findOrCreateByBrandModel(
    context: UserServiceContext,
    input: {
      brand: string | null | undefined;
      modelNumber: string | null | undefined;
      title?: string | null;
      category?: string | null;
      subcategory?: string | null;
      identityConfidence?: number;
      source?: Pick<CreateProductModelDto, 'sourceType' | 'sourceSystem' | 'sourceId'>;
      metadata?: Record<string, unknown>;
    },
    /**
     * Join the caller's transaction. Required when several lines of one receipt
     * name the same product: without it the second call runs on a different
     * connection, cannot see the first's uncommitted INSERT, and both the
     * INSERT and the read-back miss — so the line silently gets no product.
     */
    manager?: EntityManager,
  ): Promise<ProductModel | null> {
    const brand = input.brand?.trim() || null;
    const modelNumber = input.modelNumber?.trim() || null;

    if (brand == null || modelNumber == null) {
      return null;
    }

    const title = input.title?.trim() || `${brand} ${modelNumber}`;
    const confidence = this.validConfidence(input.identityConfidence) ?? FIND_OR_CREATE_IDENTITY_CONFIDENCE;

    const runner = manager ?? this.repository.manager;

    await runner.query<ProductIdRow[]>(
      `INSERT INTO ci.product_models (
         product_id, user_id, owner_user_id, title, brand, model_number,
         category, subcategory, identity_confidence, metadata,
         source_type, source_system, source_id
       )
       VALUES ($1::uuid, $2::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::real, $9::jsonb, $10, $11, $12)
       ON CONFLICT ${BRAND_MODEL_CONFLICT_TARGET}
       DO NOTHING
       RETURNING product_id`,
      [
        uuid7(),
        context.userId,
        title,
        brand,
        modelNumber,
        input.category ?? null,
        input.subcategory ?? null,
        confidence,
        JSON.stringify(input.metadata ?? {}),
        input.source?.sourceType ?? null,
        input.source?.sourceSystem ?? null,
        input.source?.sourceId ?? null,
      ],
    );

    // Read back through the SAME normalization the index uses, so the row found
    // is by definition the row the INSERT would have conflicted with. Never
    // trust the RETURNING alone: on the DO NOTHING branch it is empty, which is
    // exactly the case that has to resolve to the winner.
    const [row] = await runner.query<ProductIdRow[]>(
      `SELECT product_id
         FROM ci.product_models
        WHERE owner_user_id = $1::uuid
          AND lower(btrim(brand)) = lower(btrim($2))
          AND lower(btrim(model_number)) = lower(btrim($3))
          AND merged_into_product_id IS NULL
        LIMIT 1`,
      [context.userId, brand, modelNumber],
    );

    if (row == null) {
      // Only reachable if the row was merged away between the two statements.
      this.logger.warn('findOrCreateByBrandModel found no live row after insert', { brand, modelNumber });

      return null;
    }

    return this.findById(context, row.product_id, manager);
  }

  /**
   * Resolve a raw identifier (a scanned barcode, an ASIN off a receipt) to the
   * catalog model that claims it.
   *
   * Delegates the whole normalization + lookup to
   * {@link ObjectIdentifierService} — this class never re-implements the
   * GTIN/ISBN rule, because a value normalized by a second rule is a claim that
   * can never be found again.
   *
   * A claim held by an object INSTANCE (a serial number) is not a product
   * match and yields `null`; so does a claim pointing at a model that has since
   * been merged away, since {@link findById} filters tombstones.
   */
  async resolveByIdentifier(
    context: UserServiceContext,
    namespace: ObjectIdentifierNamespace,
    rawValue: string,
    scope: { brand?: string | null; sourceSystem?: string | null } = {},
    manager?: EntityManager,
  ): Promise<ProductModel | null> {
    const match = await this.objectIdentifierService.resolve(
      context.userId,
      namespace,
      rawValue,
      scope,
      manager,
    );

    if (match == null || match.subjectType !== 'product_model') {
      return null;
    }

    return this.findById(context, match.subjectId, manager);
  }
}
