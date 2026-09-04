import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, In, IsNull, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  appendRecordSources,
  type BulkInsertResult,
  bulkInsertIdempotent,
  computeChunkSize,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { ObjectIdentifierService } from '@ci/domains/graph/services/ObjectIdentifierService';
import type {
  ObjectIdentifierBatchEntry,
  RawObjectIdentifier,
} from '@ci/domains/graph/services/ObjectIdentifierService';
import type { ObjectIdentifierNamespace } from '@ci/domains/graph/utils/normalizeObjectIdentifier';
import { ReceiptUpdatedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Receipt, ReceiptEntity } from '../entities/ReceiptEntity';
import { type ReceiptLineItem, ReceiptLineItemEntity } from '../entities/ReceiptLineItemEntity';
import type {
  CreateReceiptDto,
  FindReceiptsFilter,
  ReceiptExtraction,
  ReceiptLineItemInput,
  UpdateReceiptDto,
} from '../types';

import { type MintLineInput, type MintResult, ObjectMintService } from './ObjectMintService';
import { ProductModelService } from './ProductModelService';

/**
 * The timestamp the explorer browse orders receipts by, as SQL.
 *
 * One constant because it is used four times across
 * {@link ReceiptService.getEntitiesForReceipts} and
 * {@link ReceiptService.countEntitiesForReceipts} (sort key, keyset predicate,
 * date-range bounds) and a copy that drifts silently mis-pages the feed.
 *
 * Falls back to `updated_at`, not `created_at`: the explorer's plain browse
 * orders every row-stamped kind by its last change, so an undated receipt that
 * was re-extracted or edited surfaces when that happened, and at worst (never
 * touched since insert) the two columns are equal.
 *
 * @see backend/apps/api/db/postgres/migrations/20260819211924_add_receipts_browse_time_index.sql
 * @see the `receipts_user_browse_updated_idx` migration that re-keys that index on this expression.
 */
const RECEIPT_BROWSE_TIME = 'COALESCE(receipt.purchased_at, receipt.updated_at)';

/** The `receipts_source_identity_uniq` arbiter. */
const SOURCE_IDENTITY_CONFLICT_TARGET =
  '(owner_user_id, source_system, source_id) WHERE source_id IS NOT NULL';

/**
 * Confidence written onto an identifier claim promoted off a receipt line, by
 * how the line was read.
 *
 * These are the tiers the `ci.product_models.identity_confidence` column
 * comment names, and they are NOT interchangeable. An OCR pass over a crumpled
 * thermal receipt misreads a digit often enough that its claims must lose to a
 * scan or a feed; a retailer's own structured order export does not.
 */
export const OCR_IDENTIFIER_CONFIDENCE = 0.7;
export const STRUCTURED_IDENTIFIER_CONFIDENCE = 0.85;

/** Provenance stamped on identifier claims this service promotes. */
const IDENTIFIER_SOURCE = 'receipt';

/**
 * Which `identifierCodes` key means which namespace.
 *
 * The namespace the normalizer RETURNS may differ from the one requested — an
 * all-digit ASIN is an ISBN-10 and comes back as `isbn` — and the returned one
 * is what is stored. That re-routing is the whole reason these go through
 * `ObjectIdentifierService` instead of `String(code).toUpperCase()`.
 *
 * `order_id` is deliberately ABSENT. The claim index is first-writer-wins on
 * `(owner, namespace, value, qualifier)`, and an order id belongs to the ORDER,
 * not to any one thing in it — claiming it for a single line would silently
 * swallow every other line on the same order. Same reasoning as
 * `ObjectPromoteStage.IDENTIFIER_SOURCES`.
 */
const CODE_KEY_NAMESPACES: Readonly<Record<string, ObjectIdentifierNamespace>> = {
  gtin: 'gtin',
  upc: 'gtin',
  ean: 'gtin',
  isbn: 'isbn',
  asin: 'asin',
  mpn: 'mpn',
  sku: 'sku',
  serial: 'serial',
  imei: 'imei',
  vin: 'vin',
};

/**
 * Namespaces that identify a MODEL, not a unit.
 *
 * A GTIN is printed on every copy of a product; a serial is unique to one. The
 * split decides which subject a promoted claim is attached to, and getting it
 * backwards is not cosmetic — a GTIN claimed by one owned unit makes every
 * other unit of the same product unfindable by barcode, forever, because the
 * index is first-writer-wins.
 */
const PRODUCT_LEVEL_NAMESPACES: ReadonlySet<ObjectIdentifierNamespace> = new Set([
  'gtin',
  'isbn',
  'asin',
  'mpn',
  'sku',
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A receipt plus its lines, in line order. */
export interface ReceiptWithLines {
  receipt: Receipt;
  lines: ReceiptLineItem[];
}

/** One page of receipts, newest purchase first. */
export interface ReceiptPage {
  receipts: Receipt[];
  hasMore: boolean;
  /** Cursor for the next page; null when this page is the last. */
  nextCursor: { purchasedAt: Date | null; id: string } | null;
}

/** What one {@link ReceiptService.upsertFromExtraction} call did. */
export interface ReceiptExtractionResult {
  receipt: Receipt;
  lines: ReceiptLineItem[];
  /** Lines whose `productId` this call resolved or minted. */
  productsResolved: number;
  /** Identifier claims inserted into `ci.object_identifiers`. */
  identifiersPromoted: number;
  mints: MintResult[];
}

/** A line, flattened for the `unnest` write. */
interface LineRow {
  id: string | null;
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceMinor: number | null;
  totalPriceMinor: number | null;
  currency: string | null;
  productId: string | null;
  brand: string | null;
  modelNumber: string | null;
  category: string | null;
  isPhysical: boolean;
  metadata: string;
}

/**
 * Read/write surface for `ci.receipts` and `ci.receipt_line_items` — purchase
 * EVIDENCE and the per-product CLAIMS on it.
 *
 * The chain is receipt (evidence) -> line item (claim) -> `ci.objects` (owned
 * unit). Keeping the three apart is what makes "where did this come from?"
 * answerable: before these tables the importer flattened a whole purchase into
 * ONE object row named after the order, so a four-item Amazon order became
 * one "thing" and the tax and shipping were lost.
 *
 * ── Money ──────────────────────────────────────────────────────────────────
 *
 * Integer MINOR units of an ISO-4217 currency, end to end. Never decimal — see
 * {@link minorUnitsTransformer} for the bug that rule exists to avoid.
 *
 * ── Line numbering ─────────────────────────────────────────────────────────
 *
 * `line_number` is 1-based and STABLE. It is half of the natural key
 * `(receipt_id, line_number)`, so a re-extraction that renumbers its lines does
 * not update them, it forks them. {@link replaceLineItems} is the only writer,
 * and it upserts on that key.
 */
@Injectable()
export class ReceiptService {
  constructor(
    @InjectRepository(ReceiptEntity)
    private readonly receiptRepository: Repository<ReceiptEntity>,
    @InjectRepository(ReceiptLineItemEntity)
    private readonly lineRepository: Repository<ReceiptLineItemEntity>,
    private readonly productModelService: ProductModelService,
    private readonly objectIdentifierService: ObjectIdentifierService,
    private readonly objectMintService: ObjectMintService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ReceiptService.name);
  }

  private userScope(context: ServiceContext) {
    return context.userId !== SYSTEM_USER ? { userId: context.userId } : {};
  }

  /** The column set shared by `create` and `createMany`. */
  private toEntity(context: UserServiceContext, dto: CreateReceiptDto): ReceiptEntity {
    return this.receiptRepository.create({
      id: dto.id ?? uuid7(),
      userId: context.userId,
      ownerUserId: context.userId,
      merchantName: dto.merchantName ?? null,
      merchantEntityId: dto.merchantEntityId ?? null,
      placeEntityId: dto.placeEntityId ?? null,
      purchasedAt: dto.purchasedAt ?? null,
      currency: dto.currency ?? null,
      subtotalMinor: dto.subtotalMinor ?? null,
      taxMinor: dto.taxMinor ?? null,
      tipMinor: dto.tipMinor ?? null,
      shippingMinor: dto.shippingMinor ?? null,
      discountMinor: dto.discountMinor ?? null,
      totalMinor: dto.totalMinor ?? null,
      paymentMethod: dto.paymentMethod ?? null,
      paymentLast4: dto.paymentLast4 ?? null,
      orderNumber: dto.orderNumber ?? null,
      channel: dto.channel ?? null,
      documentContentId: dto.documentContentId ?? null,
      sourceFileId: dto.sourceFileId ?? null,
      sourceMessageId: dto.sourceMessageId ?? null,
      extractionState: dto.extractionState ?? 'pending',
      extractionConfidence: dto.extractionConfidence ?? null,
      extractionModel: dto.extractionModel ?? null,
      extractionError: dto.extractionError ?? null,
      rawText: dto.rawText ?? null,
      eventId: dto.eventId ?? null,
      metadata: dto.metadata ?? {},
      sourceType: dto.sourceType ?? null,
      sourceSystem: dto.sourceSystem ?? null,
      sourceId: dto.sourceId ?? null,
    });
  }

  async create(context: UserServiceContext, dto: CreateReceiptDto): Promise<Receipt> {
    return this.receiptRepository.save(this.toEntity(context, dto));
  }

  /** Batch ingest, idempotent on the provenance triple. */
  async createMany(context: UserServiceContext, dtos: CreateReceiptDto[]): Promise<Receipt[]> {
    return (await this.createManyDetailed(context, dtos)).map(({ entity }) => entity);
  }

  /** Same as {@link createMany}, reporting which rows this call actually INSERTED. */
  async createManyDetailed(
    context: UserServiceContext,
    dtos: CreateReceiptDto[],
  ): Promise<Array<BulkInsertResult<Receipt>>> {
    if (dtos.length === 0) {
      return [];
    }

    return bulkInsertIdempotent({
      repository: this.receiptRepository,
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
      sourceLedger: { table: 'receipts', userId: context.userId, importRunId: context.importRunId ?? null },
    });
  }

  async findById(context: ServiceContext, id: string, manager?: EntityManager): Promise<Receipt | null> {
    const repository = manager ? manager.withRepository(this.receiptRepository) : this.receiptRepository;

    return repository.findOne({ where: { id, ...this.userScope(context) } });
  }

  /** Batched read, preserving input order and holding `null` for misses. */
  async findByIds(context: ServiceContext, ids: string[]): Promise<Array<Receipt | null>> {
    if (ids.length === 0) {
      return [];
    }

    const unique = [...new Set(ids)];
    const found: ReceiptEntity[] = [];
    // One bind parameter per id, so the IN-list is chunked like every other
    // batched read in this domain.
    const chunkSize = computeChunkSize(1);

    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const slice = unique.slice(offset, offset + chunkSize);

      found.push(
        ...(await this.receiptRepository.find({ where: { id: In(slice), ...this.userScope(context) } })),
      );
    }

    const byId = new Map(found.map((row) => [row.id, row]));

    return ids.map((id) => byId.get(id) ?? null);
  }

  /** The receipt with its lines in `line_number` order — the shape a detail page wants. */
  async findByIdWithLines(
    context: ServiceContext,
    id: string,
    manager?: EntityManager,
  ): Promise<ReceiptWithLines | null> {
    const receipt = await this.findById(context, id, manager);

    if (receipt == null) {
      return null;
    }

    return { receipt, lines: await this.findLines(context, id, manager) };
  }

  /** A receipt's lines, in `line_number` order. */
  async findLines(
    context: ServiceContext,
    receiptId: string,
    manager?: EntityManager,
  ): Promise<ReceiptLineItem[]> {
    const repository = manager ? manager.withRepository(this.lineRepository) : this.lineRepository;

    return repository.find({
      where: { receiptId, ...this.userScope(context) },
      order: { lineNumber: 'ASC' },
    });
  }

  /**
   * Keyset page of receipts, newest purchase first.
   *
   * Ordered `(purchased_at DESC NULLS LAST, receipt_id DESC)` to match
   * `receipts_user_time_idx`, which means the seek predicate has THREE cases,
   * not one:
   *
   *  - no cursor — the first page;
   *  - a cursor with a timestamp — everything strictly older, plus the whole
   *    NULL tail (NULLS LAST puts undated receipts after every dated one);
   *  - a cursor with no timestamp — we are already inside the NULL tail, so
   *    only the id breaks the tie.
   *
   * Collapsing those into `purchased_at < :after` would silently drop every
   * undated receipt from every page after the first, which on an OCR backlog is
   * most of them.
   */
  async find(context: ServiceContext, filter: FindReceiptsFilter = {}): Promise<ReceiptPage> {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const qb = this.receiptRepository
      .createQueryBuilder('receipt')
      .orderBy('receipt.purchased_at', 'DESC', 'NULLS LAST')
      .addOrderBy('receipt.receipt_id', 'DESC')
      // One sentinel row past the page tells us whether there is a next page
      // without a second COUNT.
      .limit(limit + 1);

    if (context.userId !== SYSTEM_USER) {
      qb.andWhere('receipt.user_id = :userId', { userId: context.userId });
    }

    if (filter.merchantName != null) {
      qb.andWhere('lower(btrim(receipt.merchant_name)) = lower(btrim(:merchantName))', {
        merchantName: filter.merchantName,
      });
    }

    if (filter.merchantEntityId != null) {
      qb.andWhere('receipt.merchant_entity_id = :merchantEntityId', {
        merchantEntityId: filter.merchantEntityId,
      });
    }

    if (filter.placeEntityId != null) {
      qb.andWhere('receipt.place_entity_id = :placeEntityId', { placeEntityId: filter.placeEntityId });
    }

    if (filter.extractionState != null) {
      qb.andWhere('receipt.extraction_state = :extractionState', {
        extractionState: filter.extractionState,
      });
    }

    if (filter.purchasedFrom != null) {
      qb.andWhere('receipt.purchased_at >= :purchasedFrom', { purchasedFrom: filter.purchasedFrom });
    }

    if (filter.purchasedTo != null) {
      qb.andWhere('receipt.purchased_at <= :purchasedTo', { purchasedTo: filter.purchasedTo });
    }

    if (filter.afterId != null) {
      if (filter.afterPurchasedAt != null) {
        qb.andWhere(
          `(receipt.purchased_at IS NULL
            OR receipt.purchased_at < :afterPurchasedAt
            OR (receipt.purchased_at = :afterPurchasedAt AND receipt.receipt_id < :afterId))`,
          { afterPurchasedAt: filter.afterPurchasedAt, afterId: filter.afterId },
        );
      } else {
        qb.andWhere('receipt.purchased_at IS NULL AND receipt.receipt_id < :afterId', {
          afterId: filter.afterId,
        });
      }
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const receipts = hasMore ? rows.slice(0, limit) : rows;
    const last = receipts[receipts.length - 1];

    return {
      receipts,
      hasMore,
      nextCursor: hasMore && last ? { purchasedAt: last.purchasedAt, id: last.id } : null,
    };
  }

  /**
   * Identifiers for the explorer's browse, newest purchase first.
   *
   * ── Why `COALESCE(purchased_at, created_at)` and not either column alone ───
   *
   * A receipt is the one thing in this domain with a real domain timestamp:
   * `purchased_at` is WHEN THE PURCHASE HAPPENED, so ordering the browse by
   * `created_at` (the import's write time, identical for every row of a bulk
   * load) would be a lie about a column that knows better. But `purchased_at`
   * is nullable — an OCR backlog is mostly undated — and dropping those rows or
   * sinking them to the epoch would hide them from the very browse that exists
   * to reach them. The coalesce keeps both honest: dated receipts sit at their
   * purchase date, undated ones fall back to the only time they have.
   *
   * The expression is the sort key, the keyset key AND the cursor key, and all
   * three must agree or paging dead-ends — `SearchResolver.getEntityTimestamp`
   * reads `purchasedAt ?? createdAt` for exactly this reason. It is backed by
   * `receipts_user_browse_idx`; `receipts_user_time_idx` cannot serve it,
   * because a `NULLS LAST` ordering on the bare column puts the undated tail
   * somewhere the coalesced order does not.
   *
   * Receipts are nonetheless a member of `SearchResolver.BROWSE_OPT_IN_TYPES`:
   * they join the feed when the caller NAMES them (the What picker's
   * "Receipts"), not on the unfiltered chronological browse, because the
   * undated share of them would otherwise land at import time ahead of the
   * whole timeline — the problem that gate exists to prevent.
   */
  async getEntitiesForReceipts(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      connectors?: string[];
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.receiptRepository
      .createQueryBuilder('receipt')
      .select('receipt.receipt_id', 'id')
      .where('receipt.user_id = :userId', { userId: context.userId });

    // The How filter: keep rows from the named sources. Every browsed table
    // with a source_system column applies this same clause (see
    // SearchResolver.searchByTimedEntities), so a source selected on /memory
    // narrows every kind it can, not just events.
    if (options.connectors && options.connectors.length > 0) {
      query = query.andWhere('receipt.source_system IN (:...connectors)', { connectors: options.connectors });
    }

    if (options.startTime) {
      query = query.andWhere(`${RECEIPT_BROWSE_TIME} >= :startTime`, { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere(`${RECEIPT_BROWSE_TIME} <= :endTime`, { endTime: options.endTime });
    }

    // Composite keyset: page strictly past (afterTime, afterId) in
    // (browse time DESC, receipt_id DESC) — see ItemService.getEntitiesForItems.
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        `(${RECEIPT_BROWSE_TIME} < :afterTime
          OR (${RECEIPT_BROWSE_TIME} = :afterTime AND receipt.receipt_id < :afterId))`,
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    query = query
      .orderBy(RECEIPT_BROWSE_TIME, options.order ?? 'DESC')
      .addOrderBy('receipt.receipt_id', 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'receipt' as IndexableEntity }));
  }

  /**
   * True total behind {@link getEntitiesForReceipts} — the same predicates minus
   * the pagination-only ones, as a real `COUNT(*)`. See
   * ItemService.countEntitiesForItems for why the page length will not do.
   */
  async countEntitiesForReceipts(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date; connectors?: string[] } = {},
  ): Promise<number> {
    let query = this.receiptRepository
      .createQueryBuilder('receipt')
      .where('receipt.user_id = :userId', { userId: context.userId });

    // The How filter: keep rows from the named sources. Every browsed table
    // with a source_system column applies this same clause (see
    // SearchResolver.searchByTimedEntities), so a source selected on /memory
    // narrows every kind it can, not just events.
    if (options.connectors && options.connectors.length > 0) {
      query = query.andWhere('receipt.source_system IN (:...connectors)', { connectors: options.connectors });
    }

    if (options.startTime) {
      query = query.andWhere(`${RECEIPT_BROWSE_TIME} >= :startTime`, { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere(`${RECEIPT_BROWSE_TIME} <= :endTime`, { endTime: options.endTime });
    }

    return query.getCount();
  }

  /** Patch a receipt header. Absent keys are left alone; an explicit `null` clears. */
  async update(context: ServiceContext, id: string, dto: UpdateReceiptDto): Promise<Receipt | null> {
    const patch: Partial<ReceiptEntity> = {};
    const assign = <K extends keyof ReceiptEntity>(key: K, value: ReceiptEntity[K] | undefined) => {
      if (value !== undefined) {
        patch[key] = value;
      }
    };

    assign('merchantName', dto.merchantName);
    assign('merchantEntityId', dto.merchantEntityId);
    assign('placeEntityId', dto.placeEntityId);
    assign('purchasedAt', dto.purchasedAt);
    assign('currency', dto.currency);
    assign('subtotalMinor', dto.subtotalMinor);
    assign('taxMinor', dto.taxMinor);
    assign('tipMinor', dto.tipMinor);
    assign('shippingMinor', dto.shippingMinor);
    assign('discountMinor', dto.discountMinor);
    assign('totalMinor', dto.totalMinor);
    assign('paymentMethod', dto.paymentMethod);
    assign('paymentLast4', dto.paymentLast4);
    assign('orderNumber', dto.orderNumber);
    assign('channel', dto.channel);
    assign('documentContentId', dto.documentContentId);
    assign('sourceFileId', dto.sourceFileId);
    assign('sourceMessageId', dto.sourceMessageId);
    assign('extractionState', dto.extractionState);
    assign('extractionConfidence', dto.extractionConfidence);
    assign('extractionModel', dto.extractionModel);
    assign('extractionError', dto.extractionError);
    assign('rawText', dto.rawText);
    assign('eventId', dto.eventId);
    assign('metadata', dto.metadata);

    if (Object.keys(patch).length === 0) {
      return this.findById(context, id);
    }

    // TypeORM's update builder types a jsonb `Record<string, unknown>` column as
    // a deep-partial it cannot accept; the same cast ItemService.update carries.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writable = patch as any;

    await this.receiptRepository.update({ id, ...this.userScope(context) }, writable);

    await this.eventService.send(ReceiptUpdatedEvent, { receiptId: id });

    return this.findById(context, id);
  }

  /**
   * Make the supplied lines the receipt's lines.
   *
   * Upserts on the natural key `(receipt_id, line_number)`, so a re-extraction
   * updates each line IN PLACE — that is the whole reason the key is
   * `line_number` and not a hash of the description, which would fork every
   * line the moment OCR read one character differently.
   *
   * `minted_object_id` is absent from the refresh list: the link to the owned
   * unit is `ObjectMintService`'s to write, and clobbering it here would strand
   * a possession whose provenance pointer had just been erased.
   *
   * ── What "replace" does NOT do ─────────────────────────────────────────────
   *
   * Lines whose number is no longer present are deleted ONLY if they never
   * minted anything. A minted line is kept and logged instead: deleting it
   * would fire `ON DELETE SET NULL` on
   * `ci.objects.acquisition_line_item_id`, leaving the user's thing in place
   * with its provenance silently cut. A shorter re-extraction is far more often
   * a worse read than a corrected one, and an orphaned possession is not
   * recoverable from the receipt.
   */
  async replaceLineItems(
    context: UserServiceContext,
    receiptId: string,
    lines: ReceiptLineItemInput[],
    manager?: EntityManager,
  ): Promise<ReceiptLineItem[]> {
    const em = manager ?? this.lineRepository.manager;

    // Collapse within-batch repeats before the statement runs: two rows sharing
    // a conflict target make Postgres abort the WHOLE chunk with "ON CONFLICT
    // DO UPDATE command cannot affect row a second time", so a source that
    // emitted line 3 twice would lose every line in the slice, not the
    // duplicate. Last write wins, matching ObjectObservationService.
    const byLineNumber = new Map<number, ReceiptLineItemInput>();

    for (const line of lines) {
      byLineNumber.set(line.lineNumber, line);
    }

    const rows: LineRow[] = [...byLineNumber.values()]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((line) => ({
        id: null,
        lineNumber: line.lineNumber,
        description: line.description,
        quantity: line.quantity ?? 1,
        unitPriceMinor: line.unitPriceMinor ?? null,
        totalPriceMinor: line.totalPriceMinor ?? null,
        currency: line.currency ?? null,
        productId: line.productId ?? null,
        brand: line.brand ?? null,
        modelNumber: line.modelNumber ?? null,
        category: line.category ?? null,
        isPhysical: line.isPhysical ?? true,
        metadata: JSON.stringify(line.metadata ?? {}),
      }));

    if (rows.length > 0) {
      const chunkSize = computeChunkSize(this.lineRepository.metadata.columns.length);

      for (let offset = 0; offset < rows.length; offset += chunkSize) {
        const chunk = rows.slice(offset, offset + chunkSize);

        await em.query(
          `INSERT INTO ci.receipt_line_items AS li (
             line_item_id, receipt_id, user_id, owner_user_id, line_number, description,
             quantity, unit_price_minor, total_price_minor, currency,
             product_id, brand, model_number, category, is_physical, metadata
           )
           SELECT COALESCE(u.id, ci.gen_uuid_v7()), $1::uuid, $2::uuid, $2::uuid,
                  u.line_number, u.description,
                  u.quantity, u.unit_price_minor, u.total_price_minor, u.currency,
                  u.product_id, u.brand, u.model_number, u.category, u.is_physical,
                  COALESCE(u.metadata, '{}'::jsonb)
             FROM unnest(
                    $3::uuid[], $4::int[], $5::text[], $6::numeric[], $7::bigint[],
                    $8::bigint[], $9::text[], $10::uuid[], $11::text[], $12::text[],
                    $13::text[], $14::boolean[], $15::jsonb[]
                  ) AS u(id, line_number, description, quantity, unit_price_minor,
                         total_price_minor, currency, product_id, brand, model_number,
                         category, is_physical, metadata)
           ON CONFLICT (receipt_id, line_number)
           DO UPDATE SET
                description       = excluded.description,
                quantity          = excluded.quantity,
                unit_price_minor  = excluded.unit_price_minor,
                total_price_minor = excluded.total_price_minor,
                currency          = excluded.currency,
                product_id        = COALESCE(excluded.product_id, li.product_id),
                brand             = excluded.brand,
                model_number      = excluded.model_number,
                category          = excluded.category,
                is_physical       = excluded.is_physical,
                metadata          = COALESCE(li.metadata, '{}'::jsonb) || excluded.metadata,
                updated_at        = now()`,
          [
            receiptId,
            context.userId,
            chunk.map((row) => row.id),
            chunk.map((row) => row.lineNumber),
            chunk.map((row) => row.description),
            chunk.map((row) => row.quantity),
            chunk.map((row) => row.unitPriceMinor),
            chunk.map((row) => row.totalPriceMinor),
            chunk.map((row) => row.currency),
            chunk.map((row) => row.productId),
            chunk.map((row) => row.brand),
            chunk.map((row) => row.modelNumber),
            chunk.map((row) => row.category),
            chunk.map((row) => row.isPhysical),
            chunk.map((row) => row.metadata),
          ],
        );
      }
    }

    const keptNumbers = rows.map((row) => row.lineNumber);
    // Wrapped in a CTE so the outer command is a SELECT. TypeORM's Postgres
    // runner resolves the PAIR `[rows, rowCount]` for a bare
    // `DELETE … RETURNING`, so `orphaned.length` on the unwrapped form is a
    // constant 2 — it would report "Removed 2 unminted receipt line(s)"
    // whether it removed none or nine.
    const orphaned = await em.query<Array<{ line_number: number }>>(
      `WITH removed AS (
         DELETE FROM ci.receipt_line_items
          WHERE receipt_id = $1::uuid
            AND user_id = $2::uuid
            AND NOT (line_number = ANY($3::int[]))
            AND minted_object_id IS NULL
          RETURNING line_number
       )
       SELECT line_number FROM removed ORDER BY line_number`,
      [receiptId, context.userId, keptNumbers],
    );

    const strandedMints = await em.query<Array<{ line_number: number }>>(
      `SELECT line_number
         FROM ci.receipt_line_items
        WHERE receipt_id = $1::uuid
          AND user_id = $2::uuid
          AND NOT (line_number = ANY($3::int[]))
          AND minted_object_id IS NOT NULL`,
      [receiptId, context.userId, keptNumbers],
    );

    if (strandedMints.length > 0) {
      this.logger.warn('Kept receipt lines a re-extraction dropped, because they minted owned units', {
        receiptId,
        lineNumbers: strandedMints.map((row) => row.line_number),
      });
    }

    if (orphaned.length > 0) {
      this.logger.log(`Removed ${orphaned.length} unminted receipt line(s) a re-extraction dropped`, {
        receiptId,
      });
    }

    return this.findLines(context, receiptId, em);
  }

  /**
   * Apply a whole extracted receipt — header, lines, product resolution,
   * identifier promotion and minting — as ONE transaction.
   *
   * ── Why one transaction ────────────────────────────────────────────────────
   *
   * Every step here writes a pointer into a step that came before it: a line
   * points at a product, an identifier claim points at a product or a unit, a
   * minted unit points at a line. Committing them separately means a failure
   * halfway leaves a claim pointing at a product that was rolled back — and
   * because the claim index is FIRST-WRITER-WINS, that ghost claim is
   * permanent: the barcode can never be re-claimed by the real product. This is
   * also why `ObjectIdentifierService.upsertForSubjects` and
   * `ProductModelService.findOrCreateByBrandModel` take the manager.
   *
   * ── The order, and why ─────────────────────────────────────────────────────
   *
   *  1. Upsert the header (by provenance triple when there is one, else by id).
   *  2. Upsert the lines on `(receipt_id, line_number)`.
   *  3. Resolve each line's `productId` — first by any identifier the line
   *     carries (a barcode is an ANSWER), else find-or-create by brand+model
   *     (two strings are a GUESS, and the model is written at the lower
   *     confidence to say so).
   *  4. Promote the line's PRODUCT-level codes onto the resolved product.
   *  5. Mint owned units for the physical lines.
   *  6. Promote the line's INSTANCE-level codes (serials, IMEI, VIN) onto the
   *     units step 5 just created — they cannot be promoted before the units
   *     exist, and attaching a serial to a product model would be wrong anyway.
   */
  async upsertFromExtraction(
    context: UserServiceContext,
    extraction: ReceiptExtraction,
  ): Promise<ReceiptExtractionResult> {
    const confidence =
      extraction.extractionSource === 'structured'
        ? STRUCTURED_IDENTIFIER_CONFIDENCE
        : OCR_IDENTIFIER_CONFIDENCE;

    return this.receiptRepository.manager.transaction(async (em) => {
      const receipt = await this.upsertHeader(context, extraction, em);
      const lines = await this.replaceLineItems(context, receipt.id, extraction.lines, em);

      // Line inputs keyed by number, so the persisted row (which owns the
      // line_item_id) can be paired with the identifiers/serials the caller
      // supplied but the table does not store.
      const inputByNumber = new Map(extraction.lines.map((line) => [line.lineNumber, line]));

      let productsResolved = 0;
      let identifiersPromoted = 0;
      const productAssignments: Array<{ lineItemId: string; productId: string }> = [];
      const productClaims: Array<{ productId: string; identifiers: RawObjectIdentifier[] }> = [];

      for (const line of lines) {
        const input = inputByNumber.get(line.lineNumber);
        const identifiers = this.identifiersOf(input);

        const productId =
          line.productId ??
          (await this.resolveProductId(context, line, identifiers.productLevel, confidence, em));

        if (productId != null && productId !== line.productId) {
          productAssignments.push({ lineItemId: line.id, productId });
          productsResolved += 1;
        }

        if (productId != null && identifiers.productLevel.length > 0) {
          productClaims.push({
            productId,
            identifiers: identifiers.productLevel.map((identifier) => ({ ...identifier, confidence })),
          });
        }
      }

      if (productAssignments.length > 0) {
        await em.query(
          `UPDATE ci.receipt_line_items AS li
              SET product_id = u.product_id, updated_at = now()
             FROM unnest($2::uuid[], $3::uuid[]) AS u(line_item_id, product_id)
            WHERE li.line_item_id = u.line_item_id AND li.user_id = $1::uuid`,
          [
            context.userId,
            productAssignments.map((row) => row.lineItemId),
            productAssignments.map((row) => row.productId),
          ],
        );
      }

      if (productClaims.length > 0) {
        identifiersPromoted += await this.objectIdentifierService.upsertForSubjects(
          context.userId,
          productClaims.map((claim) => ({
            subjectType: 'product_model' as const,
            subjectId: claim.productId,
            identifiers: claim.identifiers,
            source: IDENTIFIER_SOURCE,
          })),
          em,
        );
      }

      // Re-read so the mint sees the product ids just assigned.
      const resolvedLines = await this.findLines(context, receipt.id, em);

      let mints: MintResult[] = [];

      if (!extraction.skipMint) {
        mints = await this.objectMintService.mintFromLines(
          context,
          {
            receiptId: receipt.id,
            sourceSystem: receipt.sourceSystem,
            purchasedAt: receipt.purchasedAt,
            placeEntityId: receipt.placeEntityId,
            merchantName: receipt.merchantName,
            merchantEntityId: receipt.merchantEntityId,
            currency: receipt.currency,
          },
          resolvedLines.map((line) => this.toMintInput(line, inputByNumber.get(line.lineNumber))),
          em,
        );

        // Instance-level codes go onto the units, not the model — see
        // PRODUCT_LEVEL_NAMESPACES for why the split is not cosmetic.
        const instanceClaims: ObjectIdentifierBatchEntry[] = mints.flatMap(
          (mint): ObjectIdentifierBatchEntry[] => {
            const line = resolvedLines.find((row) => row.id === mint.lineItemId);
            const input = line ? inputByNumber.get(line.lineNumber) : undefined;
            const instanceLevel = this.identifiersOf(input).instanceLevel;

            if (instanceLevel.length === 0 || mint.objectIds.length === 0) {
              return [];
            }

            // One unit: it claims everything the line asserted. Several units
            // (a serial-split line): each claims only its own serial, which is
            // the only thing that told them apart in the first place.
            if (mint.objectIds.length === 1) {
              return [
                {
                  subjectType: 'object_instance' as const,
                  subjectId: mint.objectIds[0],
                  identifiers: instanceLevel.map((identifier) => ({ ...identifier, confidence })),
                  source: IDENTIFIER_SOURCE,
                },
              ];
            }

            const serials = [
              ...new Set((input?.serials ?? []).map((serial) => serial.trim()).filter(Boolean)),
            ];

            return mint.objectIds.flatMap((objectId, index): ObjectIdentifierBatchEntry[] => {
              const serial = serials[index];

              return serial == null
                ? []
                : [
                    {
                      subjectType: 'object_instance',
                      subjectId: objectId,
                      identifiers: [{ namespace: 'serial', value: serial, confidence }],
                      source: IDENTIFIER_SOURCE,
                    },
                  ];
            });
          },
        );

        if (instanceClaims.length > 0) {
          identifiersPromoted += await this.objectIdentifierService.upsertForSubjects(
            context.userId,
            instanceClaims,
            em,
          );
        }
      }

      return {
        receipt: (await this.findById(context, receipt.id, em)) ?? receipt,
        lines: await this.findLines(context, receipt.id, em),
        productsResolved,
        identifiersPromoted,
        mints,
      };
    });
  }

  /**
   * Upsert the receipt header inside the extraction transaction.
   *
   * Keyed on the provenance triple when the extraction carries one — the same
   * arbiter `createMany` uses, so an import and a re-extraction converge on one
   * row — and on the receipt id otherwise.
   *
   * ── `IsNull()`, not `undefined` ────────────────────────────────────────────
   *
   * `sourceSystem` must be matched EXPLICITLY, including when it is absent.
   * TypeORM 0.3.30 drops an `undefined` where-value from the generated SQL
   * (`invalidWhereValuesBehavior.undefined` defaults to `"ignore"`, and this
   * repo configures no override — it does the same for a bare `null`), so
   * `sourceSystem: extraction.sourceSystem ?? undefined` does not mean "match
   * NULL", it means "do not constrain source_system at all". A re-extraction
   * carrying no `sourceSystem` would then match a receipt imported under
   * `source_system = 'amazon'` — a row keyed by a DIFFERENT triple. The live
   * arbiter is `receipts_source_identity_uniq (owner_user_id, source_type,
   * source_system, source_id) NULLS NOT DISTINCT WHERE source_id IS NOT NULL`,
   * so NULL is a real, distinguishable key value here and the lookup has to say
   * so.
   *
   * ── Patch, never re-materialise ────────────────────────────────────────────
   *
   * On a MATCH the write is a patch of the fields the extraction actually
   * supplied. `toEntity` materialises every header column with `?? null`, so
   * saving its output over a matched row nulls `merchant_name`, `purchased_at`,
   * every `*_minor` total, `payment_last4`, `order_number`, `channel` and
   * `metadata` whenever the extraction is silent about them — which a partial
   * re-read (an OCR pass that only recovered the line items, a structured feed
   * that carries no tip) always is. Worse, `source_system` is one of those
   * columns: nulling it MOVES the row's identity key, so the next import mints
   * a duplicate or trips the unique index.
   *
   * Absent keys are left alone; an explicit `null` clears — the same convention
   * {@link ReceiptService.update} documents and uses.
   */
  private async upsertHeader(
    context: UserServiceContext,
    extraction: ReceiptExtraction,
    em: EntityManager,
  ): Promise<ReceiptEntity> {
    const repository = em.withRepository(this.receiptRepository);

    const existing =
      // Identity is (source_system, source_id) — source_type is provenance
      // and deliberately unmatched (docs/design/cross-pipeline-identity.md).
      extraction.sourceId != null
        ? await repository.findOne({
            where: {
              ownerUserId: context.userId,
              sourceSystem: extraction.sourceSystem ?? IsNull(),
              sourceId: extraction.sourceId,
            },
          })
        : extraction.id != null
          ? await repository.findOne({ where: { id: extraction.id, ...this.userScope(context) } })
          : null;

    // A finished extraction is 'extracted' unless the caller said otherwise —
    // leaving it 'pending' would put the row straight back on the drain queue
    // that just processed it.
    const extractionState = extraction.extractionState ?? 'extracted';

    // Either outcome is one arrival of this receipt — ledger it (insert AND
    // match; a match from the other pipeline is exactly the evidence
    // ci.record_sources exists to keep). Joins the caller's transaction via
    // `em`, so the ledger row commits or rolls back with the receipt.
    const ledger = async (recordId: string) => {
      if (!extraction.sourceType || !extraction.sourceSystem || !extraction.sourceId) {
        return;
      }

      await appendRecordSources(em, { table: 'receipts', userId: context.userId }, [
        {
          recordId,
          sourceType: extraction.sourceType,
          sourceSystem: extraction.sourceSystem,
          sourceId: extraction.sourceId,
          importRunId: context.importRunId ?? null,
        },
      ]);
    };

    if (existing == null) {
      const saved = await repository.save(this.toEntity(context, { ...extraction, extractionState }));

      await ledger(saved.id);

      return saved;
    }

    repository.merge(existing, this.headerPatch(extraction), { extractionState });

    const saved = await repository.save(existing);

    await ledger(saved.id);

    return saved;
  }

  /**
   * The subset of the header an extraction actually spoke about.
   *
   * Every key of {@link CreateReceiptDto} that maps to a header column, and
   * NOTHING else: an omitted key never reaches the entity, so `save` leaves the
   * stored value in place. See {@link upsertHeader} for why re-materialising
   * the whole row instead is data loss.
   *
   * `id`, `sourceType`, `sourceSystem` and `sourceId` are deliberately absent.
   * The first is the row's identity and the other three ARE the arbiter this
   * row was just found by — rewriting them from the extraction could only
   * either be a no-op or move the row off its own key.
   */
  private headerPatch(extraction: ReceiptExtraction): Partial<ReceiptEntity> {
    const patch: Partial<ReceiptEntity> = {};
    const assign = <K extends keyof ReceiptEntity>(key: K, value: ReceiptEntity[K] | undefined) => {
      if (value !== undefined) {
        patch[key] = value;
      }
    };

    assign('merchantName', extraction.merchantName);
    assign('merchantEntityId', extraction.merchantEntityId);
    assign('placeEntityId', extraction.placeEntityId);
    assign('purchasedAt', extraction.purchasedAt);
    assign('currency', extraction.currency);
    assign('subtotalMinor', extraction.subtotalMinor);
    assign('taxMinor', extraction.taxMinor);
    assign('tipMinor', extraction.tipMinor);
    assign('shippingMinor', extraction.shippingMinor);
    assign('discountMinor', extraction.discountMinor);
    assign('totalMinor', extraction.totalMinor);
    assign('paymentMethod', extraction.paymentMethod);
    assign('paymentLast4', extraction.paymentLast4);
    assign('orderNumber', extraction.orderNumber);
    assign('channel', extraction.channel);
    assign('documentContentId', extraction.documentContentId);
    assign('sourceFileId', extraction.sourceFileId);
    assign('sourceMessageId', extraction.sourceMessageId);
    assign('extractionConfidence', extraction.extractionConfidence);
    assign('extractionModel', extraction.extractionModel);
    assign('extractionError', extraction.extractionError);
    assign('rawText', extraction.rawText);
    assign('eventId', extraction.eventId);
    assign('metadata', extraction.metadata);

    return patch;
  }

  /**
   * Split a line's `identifierCodes` (plus its serials) into the claims that
   * belong to the product and the claims that belong to the unit.
   *
   * Unknown keys are DROPPED rather than filed under `custom`: a `custom` claim
   * takes a slot in a first-writer-wins index on the strength of a key nobody
   * has a grammar for, and getting it back out means a merge.
   */
  private identifiersOf(input: ReceiptLineItemInput | undefined): {
    productLevel: RawObjectIdentifier[];
    instanceLevel: RawObjectIdentifier[];
  } {
    const productLevel: RawObjectIdentifier[] = [];
    const instanceLevel: RawObjectIdentifier[] = [];

    for (const [key, value] of Object.entries(input?.identifierCodes ?? {})) {
      const namespace = CODE_KEY_NAMESPACES[key.trim().toLowerCase()];

      if (namespace == null || value == null || String(value).trim() === '') {
        continue;
      }

      const identifier: RawObjectIdentifier = {
        namespace,
        value: String(value),
        // Only meaningful for the non-globally-unique namespaces (sku, serial),
        // where computeQualifier folds it into the claim key.
        brand: input?.brand ?? null,
      };

      (PRODUCT_LEVEL_NAMESPACES.has(namespace) ? productLevel : instanceLevel).push(identifier);
    }

    for (const serial of input?.serials ?? []) {
      if (serial.trim() !== '') {
        instanceLevel.push({ namespace: 'serial', value: serial, brand: input?.brand ?? null });
      }
    }

    return { productLevel, instanceLevel };
  }

  /**
   * Which catalog model a line is about.
   *
   * Identifier first: a barcode is a globally unique ANSWER, and if one already
   * resolves to a model there is nothing to guess. Brand+model second, through
   * find-or-create, because two strings are a guess — and the model it mints
   * carries the lower `identity_confidence` that says so.
   *
   * Returns `null` when the line supports neither, which is a perfectly normal
   * outcome: "Organic Russet Potato" identifies a purchase, not a product.
   */
  private async resolveProductId(
    context: UserServiceContext,
    line: ReceiptLineItem,
    identifiers: RawObjectIdentifier[],
    confidence: number,
    em: EntityManager,
  ): Promise<string | null> {
    for (const identifier of identifiers) {
      if (identifier.value == null) {
        continue;
      }

      const match = await this.objectIdentifierService.resolve(
        context.userId,
        identifier.namespace,
        String(identifier.value),
        { brand: identifier.brand ?? null },
        em,
      );

      if (match?.subjectType === 'product_model') {
        return match.subjectId;
      }
    }

    const product = await this.productModelService.findOrCreateByBrandModel(
      context,
      {
        brand: line.brand,
        modelNumber: line.modelNumber,
        title: line.description,
        category: line.category,
        identityConfidence: confidence,
      },
      em,
    );

    return product?.id ?? null;
  }

  /** The persisted line plus the serials/codes the caller supplied, as the mint wants them. */
  private toMintInput(line: ReceiptLineItem, input: ReceiptLineItemInput | undefined): MintLineInput {
    return {
      lineItemId: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      totalPriceMinor: line.totalPriceMinor,
      currency: line.currency,
      productId: line.productId,
      brand: line.brand,
      modelNumber: line.modelNumber,
      category: line.category,
      isPhysical: line.isPhysical,
      serials: input?.serials,
      identifierCodes: input?.identifierCodes,
    };
  }
}
