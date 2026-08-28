import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { ObjectIdentifierService } from '@ci/domains/graph/services/ObjectIdentifierService';
import { ItemUpdatedEvent, ProductUpdatedEvent } from '@ci/domains/memory/events';

import { type Item, ItemEntity } from '../entities/ItemEntity';
import { type ProductModel, ProductModelEntity } from '../entities/ProductModelEntity';

/** Per-table re-point counts recorded in the `ci.entity_merges` audit row. */
export interface ObjectMergeCounts {
  identifiers: number;
  observations: number;
  objectParent: number;
  objectRelated: number;
  receiptLineItems: number;
  searchRowsDeleted: number;
  /** Tag links moved from the sources onto the target; see {@link ObjectMergeService.moveTagLinks}. */
  tagLinksMoved: number;
}

/** Per-table re-point counts for a product-model merge. */
export interface ProductMergeCounts {
  identifiers: number;
  receiptLineItems: number;
  objectProduct: number;
  observations: number;
  searchRowsDeleted: number;
}

/** The `ci.entity_merges.entity_type` values this service writes. */
const OBJECT_INSTANCE_ENTITY_TYPE = 'ObjectInstance';
const PRODUCT_MODEL_ENTITY_TYPE = 'ProductModel';

/** The `ci.objects` columns folded from the sources into the target. */
interface ObjectRow {
  object_id: string;
  user_id: string;
  merged_into_object_id: string | null;
  product_id: string | null;
  acquisition_receipt_id: string | null;
  acquisition_line_item_id: string | null;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  model: string | null;
  condition: string | null;
  currency: string | null;
  purchase_price: string | null;
  current_value: string | null;
  identifier_codes: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  quantity: number | string;
  acquired_at: Date | null;
  last_seen_at: Date | null;
  last_seen_place_entity_id: string | null;
  warranty_expires_at: Date | null;
  storage_location: string | null;
  location_description: string | null;
  lifecycle_state: string;
  identity_method: string | null;
  identity_confidence: number | string;
}

/** The `ci.product_models` columns folded from the sources into the target. */
interface ProductRow {
  product_id: string;
  user_id: string;
  merged_into_product_id: string | null;
  title: string | null;
  brand: string | null;
  manufacturer: string | null;
  model_number: string | null;
  category: string | null;
  subcategory: string | null;
  product_type: string | null;
  description: string | null;
  variant_attributes: Record<string, unknown> | null;
  spec: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  msrp_minor: string | null;
  currency: string | null;
  image_content_id: string | null;
  product_entity_id: string | null;
}

/**
 * Merges duplicate owned units (`ci.objects`) and duplicate catalog models
 * (`ci.product_models`) into one canonical row — the object-identity analogue of
 * {@link PersonMergeService}, whose structure this file follows deliberately so
 * the two read the same.
 *
 * The same physical thing routinely lands as several rows: a receipt mints one,
 * a barcode scan creates another, an importer pushes a third under its own
 * provenance triple. Idempotency keys on the triple and the identifier index is
 * first-writer-wins, so nothing upstream can collapse them — a merge is the
 * only repair.
 *
 * A merge, in ONE transaction:
 *  1. `SELECT … FOR UPDATE` on the target and every source, so two concurrent
 *     merges of an overlapping set serialize instead of interleaving;
 *  2. validates that all rows exist, belong to this user, and are LIVE (a
 *     tombstone is already folded into someone — merging it again would move
 *     data twice);
 *  3. re-points `ci.object_identifiers.subject_id`;
 *  4. re-points `ci.object_observations.resolved_object_id`;
 *  5. re-points `ci.objects.parent_object_id` and the `related_object_ids`
 *     array, de-duplicating rows that referenced two sources at once and
 *     dropping the self-references a re-point creates;
 *  6. re-points `ci.receipt_line_items.minted_object_id`;
 *  7. folds scalars — target wins every non-NULL it already has, quantities
 *     SUM, `acquired_at` takes the EARLIEST and `last_seen_at` the LATEST;
 *  8. tombstones each source (`merged_into_object_id`) and compresses any
 *     tombstone that already pointed at one, so the chain stays a single hop;
 *  9. deletes the sources' search rows, so a tombstone stops answering;
 * 10. moves the sources' `ci_search.entity_tag` links onto the target, so a tag
 *     the user put on a duplicate survives the merge instead of being stranded
 *     on the tombstone;
 * 11. writes one `ci.entity_merges` audit row per source, with the per-table
 *     counts in `details`.
 *
 * The target's `ItemUpdatedEvent` is emitted AFTER the commit, so the search
 * re-index reads the merged row rather than racing it.
 *
 * ── Known limitation: `ci.item_relationships` cannot be re-pointed ─────────
 *
 * That table addresses BOTH of its endpoints by provenance triple
 * (`from_source_type/system/id`, `to_source_type/system/id`), not by row id —
 * deliberately, because one importer item may land in `ci.events`,
 * `ci.communications`, `ci.content` or `ci.objects` depending on its kind,
 * and the triple is the table-agnostic handle both sides already share.
 *
 * A merge changes which ROW is canonical; it does not and cannot change what a
 * source system called the thing. So an edge pointing at a merged-away unit's
 * triple keeps pointing at that triple, and the only correct resolution is at
 * READ time: resolve the triple to a row, then follow `merged_into_object_id`
 * one hop. Rewriting the triples here would be worse than leaving them — it
 * would make the edges disagree with the source system they were imported from,
 * and the next import would re-create them anyway (the edges dedupe on
 * `(user_id, from-triple, to-triple, relation)`).
 */
@Injectable()
export class ObjectMergeService {
  constructor(
    @InjectRepository(ItemEntity)
    private readonly itemRepository: Repository<ItemEntity>,
    @InjectRepository(ProductModelEntity)
    private readonly productRepository: Repository<ProductModelEntity>,
    private readonly objectIdentifierService: ObjectIdentifierService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectMergeService.name);
  }

  // ---------------------------------------------------------------------------
  // Owned units
  // ---------------------------------------------------------------------------

  async mergeObjects(
    context: UserServiceContext,
    sourceIds: string[],
    targetId: string,
  ): Promise<{ target: Item; counts: ObjectMergeCounts }> {
    const userId = context.userId;
    const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);

    if (sources.length === 0) {
      throw new BadRequestException('mergeObjects needs at least one source distinct from the target');
    }

    const counts = await this.itemRepository.manager.transaction(async (em) => {
      const rows: ObjectRow[] = await em.query(
        `SELECT object_id, user_id, merged_into_object_id, product_id,
                acquisition_receipt_id, acquisition_line_item_id,
                category, subcategory, brand, model, condition, currency,
                purchase_price, current_value, identifier_codes, metadata,
                quantity, acquired_at, last_seen_at, last_seen_place_entity_id,
                warranty_expires_at, storage_location, location_description,
                lifecycle_state, identity_method, identity_confidence
           FROM ci.objects
          WHERE user_id = $1::uuid AND object_id = ANY($2::uuid[])
          FOR UPDATE`,
        [userId, [targetId, ...sources]],
      );

      const byId = new Map(rows.map((row) => [row.object_id, row]));
      const target = byId.get(targetId);

      if (target == null) {
        throw new NotFoundException(`Merge target ${targetId} not found`);
      }

      if (target.merged_into_object_id != null) {
        throw new BadRequestException('Merge target must be a live owned unit, not a tombstone');
      }

      for (const id of sources) {
        const source = byId.get(id);

        if (source == null) {
          throw new NotFoundException(`Merge source ${id} not found`);
        }

        if (source.merged_into_object_id != null) {
          throw new BadRequestException(`Merge source ${id} is already merged away`);
        }
      }

      const sourceRows = sources.map((id) => byId.get(id) as ObjectRow);
      const repointed = await this.repointObjectReferences(em, userId, sources, targetId);

      await this.foldObjectScalars(em, userId, target, sourceRows);

      await em.query(
        `UPDATE ci.objects
            SET merged_into_object_id = $3::uuid, lifecycle_state = 'archived', updated_at = now()
          WHERE user_id = $1::uuid AND object_id = ANY($2::uuid[])`,
        [userId, sources, targetId],
      );

      // Path compression. Merging B into C leaves any tombstone that already
      // pointed at B aiming at a row that is now itself a tombstone, and every
      // reader here follows exactly ONE hop. Without this, the second merge in
      // a chain silently re-strands the first one's sources.
      await em.query(
        `UPDATE ci.objects
            SET merged_into_object_id = $3::uuid, updated_at = now()
          WHERE user_id = $1::uuid AND merged_into_object_id = ANY($2::uuid[])`,
        [userId, sources, targetId],
      );

      // The CTI base row is the graph's view of the unit. Leaving it live and
      // active would keep the tombstone in every graph traversal and every
      // entity read, which is exactly the state the detail-row tombstone exists
      // to end.
      await em.query(
        `UPDATE ci.entities
            SET merged_into_entity_id = $3::uuid, is_active = FALSE, updated_at = now()
          WHERE owner_user_id = $1::uuid AND entity_id = ANY($2::uuid[]) AND entity_type = 'Item'`,
        [userId, sources, targetId],
      );

      const searchRowsDeleted = await this.deleteSearchRows(em, userId, 'item', sources);
      const tagLinksMoved = await this.moveTagLinks(em, sources, targetId);

      const counts: ObjectMergeCounts = { ...repointed, searchRowsDeleted, tagLinksMoved };

      for (const id of sources) {
        await em.query(
          `INSERT INTO ci.entity_merges
             (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)`,
          [
            userId,
            id,
            targetId,
            OBJECT_INSTANCE_ENTITY_TYPE,
            JSON.stringify({ counts, source: byId.get(id) ?? {} }),
          ],
        );
      }

      this.logger.log(`Merged ${sources.length} owned unit(s) into ${targetId}`, { counts });

      return counts;
    });

    // After the commit, so the re-index reads the merged row rather than racing
    // the transaction that produced it.
    await this.eventService.send(ItemUpdatedEvent, { itemId: targetId });

    const entity = await this.itemRepository.findOne({ where: { id: targetId, userId: context.userId } });

    if (entity == null) {
      throw new NotFoundException(`Merge target ${targetId} vanished mid-merge`);
    }

    const [base]: Array<{ name: string | null; description: string | null }> =
      await this.itemRepository.manager.query(
        `SELECT name, description FROM ci.entities WHERE entity_id = $1::uuid`,
        [targetId],
      );

    return { target: ItemEntity.toEgressType(entity, base ?? null), counts };
  }

  /**
   * Re-point every dependent reference from the sources onto the target.
   *
   * All statements are owner-scoped, and the array column is rewritten
   * set-based with a DISTINCT `unnest` so a row that referenced BOTH a source
   * and the target ends up with a single target element instead of a duplicate.
   */
  private async repointObjectReferences(
    em: EntityManager,
    userId: string,
    sources: string[],
    targetId: string,
  ): Promise<Omit<ObjectMergeCounts, 'searchRowsDeleted' | 'tagLinksMoved'>> {
    // ── Identifiers ─────────────────────────────────────────────────────────
    //
    // A PLAIN UPDATE IS CORRECT AND SUFFICIENT — no pre-delete of "colliding"
    // claims, because a collision is not representable.
    // `object_identifiers_claim_uniq` is UNIQUE on
    // `(owner_user_id, namespace, value_normalized, qualifier)` and does NOT
    // include `subject_id`, so a given claim key has at most ONE row per owner:
    // if a source holds it, the target by definition does not, and an UPDATE
    // touching only `subject_id` cannot violate an index `subject_id` is not
    // part of. A pre-DELETE here would be dead code that reads as if the index
    // were keyed differently. See ObjectIdentifierService.repointSubject, which
    // states the same argument, and PersonMergeService, which re-points the
    // identically-shaped ci.entity_identifiers with a bare UPDATE.
    let identifiers = 0;

    for (const sourceId of sources) {
      identifiers += await this.objectIdentifierService.repointSubject(
        userId,
        'object_instance',
        sourceId,
        targetId,
        em,
      );
    }

    const observations = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.object_observations SET resolved_object_id = $3::uuid, updated_at = now()
          WHERE user_id = $1::uuid AND resolved_object_id = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM repointed`,
      [userId, sources, targetId],
    );

    // A child whose parent was merged away now belongs to the target. A row
    // that IS the target must not become its own parent, hence the exclusion.
    const objectParent = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.objects SET parent_object_id = $3::uuid, updated_at = now()
          WHERE user_id = $1::uuid AND parent_object_id = ANY($2::uuid[]) AND object_id <> $3::uuid
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM repointed`,
      [userId, sources, targetId],
    );

    // Any row that would have become its own parent loses the edge entirely —
    // "this thing contains itself" is not a fact worth keeping.
    await em.query(
      `UPDATE ci.objects SET parent_object_id = NULL, updated_at = now()
        WHERE user_id = $1::uuid AND parent_object_id = ANY($2::uuid[]) AND object_id = $3::uuid`,
      [userId, sources, targetId],
    );

    const objectRelated = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.objects inv
            SET related_object_ids = sub.new_ids, updated_at = now()
           FROM (
             SELECT object_id,
                    ARRAY(
                      SELECT DISTINCT CASE WHEN x = ANY($2::uuid[]) THEN $3::uuid ELSE x END
                        FROM unnest(related_object_ids) AS x
                       -- A row related to a source must not end up related to
                       -- itself once that source becomes the target.
                       WHERE CASE WHEN x = ANY($2::uuid[]) THEN $3::uuid ELSE x END <> object_id
                    ) AS new_ids
               FROM ci.objects
              WHERE user_id = $1::uuid AND related_object_ids && $2::uuid[]
           ) sub
          WHERE inv.object_id = sub.object_id
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM repointed`,
      [userId, sources, targetId],
    );

    const receiptLineItems = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.receipt_line_items SET minted_object_id = $3::uuid, updated_at = now()
          WHERE user_id = $1::uuid AND minted_object_id = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM repointed`,
      [userId, sources, targetId],
    );

    return { identifiers, observations, objectParent, objectRelated, receiptLineItems };
  }

  /**
   * Fold the sources' scalars into the target.
   *
   * TARGET WINS every non-NULL it already has — the user (or the better source)
   * chose it, and a merge must never overwrite a known value with an older
   * one. Three columns are exceptions, because "first non-NULL" would be
   * actively wrong for them:
   *
   *  - `quantity` SUMS. Two rows for the same thing are two units of it; taking
   *    the target's count would silently destroy the rest of the possession.
   *  - `acquired_at` takes the EARLIEST. You have owned it since the first time
   *    you acquired it, not since the duplicate row was created.
   *  - `last_seen_at` takes the LATEST (with its place), because the most
   *    recent sighting is the true one and it may have landed on a source.
   *
   * The jsonb bags are MERGED with the target on top, so a key only the source
   * carried survives and a key both carried keeps the target's value.
   */
  private async foldObjectScalars(
    em: EntityManager,
    userId: string,
    target: ObjectRow,
    sources: ObjectRow[],
  ): Promise<void> {
    const all = [target, ...sources];

    const firstNonNull = <K extends keyof ObjectRow>(key: K): ObjectRow[K] | null => {
      for (const row of all) {
        const value = row[key];

        if (value != null && value !== '') {
          return value;
        }
      }

      return null;
    };

    const quantity = all.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
    const acquiredAt = earliest(all.map((row) => row.acquired_at));
    const lastSeen = all
      .filter((row) => row.last_seen_at != null)
      .sort((a, b) => (b.last_seen_at as Date).getTime() - (a.last_seen_at as Date).getTime())[0];

    // Target on top: `{...source} | {...target}` in jsonb means the right-hand
    // side wins per key.
    const mergedIdentifierCodes = Object.assign(
      {},
      ...sources.map((row) => row.identifier_codes ?? {}),
      target.identifier_codes ?? {},
    );
    const mergedMetadata = Object.assign(
      {},
      ...sources.map((row) => row.metadata ?? {}),
      target.metadata ?? {},
    );

    await em.query(
      `UPDATE ci.objects
          SET product_id                = $3::uuid,
              acquisition_receipt_id    = $4::uuid,
              acquisition_line_item_id  = $5::uuid,
              category                  = $6,
              subcategory               = $7,
              brand                     = $8,
              model                     = $9,
              condition                 = $10,
              currency                  = COALESCE($11, currency),
              purchase_price            = $12::numeric,
              current_value             = $13::numeric,
              warranty_expires_at       = $14::timestamptz,
              storage_location          = $15,
              location_description      = $16,
              identity_method           = $17,
              quantity                  = $18::int,
              acquired_at               = $19::timestamptz,
              last_seen_at              = $20::timestamptz,
              last_seen_place_entity_id = $21::uuid,
              identifier_codes          = $22::jsonb,
              metadata                  = $23::jsonb,
              updated_at                = now()
        WHERE user_id = $1::uuid AND object_id = $2::uuid`,
      [
        userId,
        target.object_id,
        firstNonNull('product_id'),
        firstNonNull('acquisition_receipt_id'),
        firstNonNull('acquisition_line_item_id'),
        firstNonNull('category'),
        firstNonNull('subcategory'),
        firstNonNull('brand'),
        firstNonNull('model'),
        firstNonNull('condition'),
        firstNonNull('currency'),
        firstNonNull('purchase_price'),
        firstNonNull('current_value'),
        firstNonNull('warranty_expires_at'),
        firstNonNull('storage_location'),
        firstNonNull('location_description'),
        firstNonNull('identity_method'),
        Math.max(1, quantity),
        acquiredAt,
        lastSeen?.last_seen_at ?? null,
        lastSeen?.last_seen_place_entity_id ?? target.last_seen_place_entity_id,
        JSON.stringify(mergedIdentifierCodes),
        JSON.stringify(mergedMetadata),
      ],
    );
  }

  /**
   * Stop the tombstones answering search.
   *
   * BOTH stores, not just the embeddings. `ci_search.vectors` is the CANDIDATE
   * source for keyword and hybrid search and is queried with no join back to
   * the source table, so deleting only the embedding leaves a merged-away row
   * fully findable — and clicking it lands on a row nothing points at. The
   * target re-indexes from the update event emitted after commit; the backfill
   * sweep skips tombstones via `ENTITY_SOURCE_MAP[…].backfillPredicate`.
   *
   * ── Why the merge deletes these itself, rather than an event doing it ──────
   *
   * A search listener cannot: every by-id read filters tombstones
   * (`ItemService.findById`, `ProductModelService.liveScope`), so a listener
   * handed a merged-away id reads `null` and returns before it could act on
   * one. Any "the tombstone branch will clean it up" arrangement is therefore
   * unreachable by construction, and the rows only go away if the transaction
   * that created the tombstone removes them.
   */
  private async deleteSearchRows(
    em: EntityManager,
    userId: string,
    entityType: 'item' | 'product',
    sources: string[],
  ): Promise<number> {
    const embeddings = await countAffected(
      em,
      `WITH removed AS (
         DELETE FROM ci_search.embeddings
          WHERE user_id = $1::uuid AND entity_type = $3 AND entity_id = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM removed`,
      [userId, sources, entityType],
    );

    const vectors = await countAffected(
      em,
      `WITH removed AS (
         DELETE FROM ci_search.vectors
          WHERE user_id = $1::uuid AND entity_type = $3 AND entity_id = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM removed`,
      [userId, sources, entityType],
    );

    return embeddings + vectors;
  }

  /**
   * Move the sources' tag links onto the target.
   *
   * `'item'` is in `TAGGABLE_ENTITIES` and `ItemType` is a member of
   * `TaggableEntityType`, so an owned unit really can carry tags — and
   * `ci_search.entity_tag` addresses its rows by `(entity_type, entity_id,
   * tag_id)` with no FK to `ci.objects` and no tombstone filter on the read
   * side. Left alone, every tag the user put on a merged-away unit stays
   * pointing at the tombstone: the tag page keeps listing a thing nothing
   * points at, and the surviving unit silently loses the label the user gave
   * it. Deleting them instead would be data loss.
   *
   * The same two statements as `PersonMergeService`, for the same two reasons:
   *
   *  - the UPDATE skips any tag the TARGET already holds and collapses a tag
   *    two sources both claimed down to one row (`DISTINCT ON (tag_id)`), so
   *    `entity_tag_unique_entry` cannot be violated mid-merge;
   *  - the DELETE clears the leftovers those two exclusions left behind, so no
   *    row is left addressing a tombstone.
   *
   * Product models are NOT taggable (`'product'` is absent from
   * `TAGGABLE_ENTITIES` and from `TaggableEntityType`), so `mergeProductModels`
   * has nothing to move. If a product entity type is ever added there, this
   * method is what it needs.
   */
  private async moveTagLinks(em: EntityManager, sources: string[], targetId: string): Promise<number> {
    const moved = await countAffected(
      em,
      `WITH relinked AS (
         UPDATE ci_search.entity_tag t
            SET entity_id = $2::uuid
          WHERE t.entity_type = 'item' AND t.entity_id = ANY($1::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM ci_search.entity_tag d
               WHERE d.entity_type = 'item' AND d.entity_id = $2::uuid AND d.tag_id = t.tag_id)
            AND t.id IN (
              SELECT DISTINCT ON (tag_id) id
                FROM ci_search.entity_tag
               WHERE entity_type = 'item' AND entity_id = ANY($1::uuid[])
               ORDER BY tag_id, id ASC)
          RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM relinked`,
      [sources, targetId],
    );

    await em.query(
      `DELETE FROM ci_search.entity_tag
        WHERE entity_type = 'item' AND entity_id = ANY($1::uuid[])`,
      [sources],
    );

    return moved;
  }

  // ---------------------------------------------------------------------------
  // Catalog models
  // ---------------------------------------------------------------------------

  /**
   * The same merge, one level up: two `ci.product_models` rows discovered to
   * name the same product.
   *
   * Shorter than the instance merge because a model owns fewer references —
   * identifier claims, the receipt lines that resolved to it, the object
   * units that are instances of it, and the observations that guessed it.
   *
   * Like {@link mergeObjects}, it deletes the sources' rows in BOTH search
   * stores inside the transaction — see {@link deleteSearchRows} for why that
   * cannot be delegated to a listener.
   */
  async mergeProductModels(
    context: UserServiceContext,
    sourceIds: string[],
    targetId: string,
  ): Promise<{ target: ProductModel; counts: ProductMergeCounts }> {
    const userId = context.userId;
    const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);

    if (sources.length === 0) {
      throw new BadRequestException('mergeProductModels needs at least one source distinct from the target');
    }

    const counts = await this.productRepository.manager.transaction(async (em) => {
      const rows: ProductRow[] = await em.query(
        `SELECT product_id, user_id, merged_into_product_id, title, brand, manufacturer,
                model_number, category, subcategory, product_type, description,
                variant_attributes, spec, metadata, msrp_minor, currency,
                image_content_id, product_entity_id
           FROM ci.product_models
          WHERE user_id = $1::uuid AND product_id = ANY($2::uuid[])
          FOR UPDATE`,
        [userId, [targetId, ...sources]],
      );

      const byId = new Map(rows.map((row) => [row.product_id, row]));
      const target = byId.get(targetId);

      if (target == null) {
        throw new NotFoundException(`Merge target ${targetId} not found`);
      }

      if (target.merged_into_product_id != null) {
        throw new BadRequestException('Merge target must be a live product model, not a tombstone');
      }

      for (const id of sources) {
        const source = byId.get(id);

        if (source == null) {
          throw new NotFoundException(`Merge source ${id} not found`);
        }

        if (source.merged_into_product_id != null) {
          throw new BadRequestException(`Merge source ${id} is already merged away`);
        }
      }

      let identifiers = 0;

      for (const sourceId of sources) {
        identifiers += await this.objectIdentifierService.repointSubject(
          userId,
          'product_model',
          sourceId,
          targetId,
          em,
        );
      }

      const receiptLineItems = await countAffected(
        em,
        `WITH repointed AS (
           UPDATE ci.receipt_line_items SET product_id = $3::uuid, updated_at = now()
            WHERE user_id = $1::uuid AND product_id = ANY($2::uuid[])
            RETURNING 1
         )
         SELECT COUNT(*)::int AS count FROM repointed`,
        [userId, sources, targetId],
      );

      const objectProduct = await countAffected(
        em,
        `WITH repointed AS (
           UPDATE ci.objects SET product_id = $3::uuid, updated_at = now()
            WHERE user_id = $1::uuid AND product_id = ANY($2::uuid[])
            RETURNING 1
         )
         SELECT COUNT(*)::int AS count FROM repointed`,
        [userId, sources, targetId],
      );

      const observations = await countAffected(
        em,
        `WITH repointed AS (
           UPDATE ci.object_observations SET resolved_product_id = $3::uuid, updated_at = now()
            WHERE user_id = $1::uuid AND resolved_product_id = ANY($2::uuid[])
            RETURNING 1
         )
         SELECT COUNT(*)::int AS count FROM repointed`,
        [userId, sources, targetId],
      );

      // ── TOMBSTONE BEFORE FOLD. The order here is load-bearing. ─────────────
      //
      // `product_models_brand_model_uniq` is UNIQUE on
      // `(owner_user_id, lower(btrim(brand)), lower(btrim(model_number)))`
      // PARTIAL on `brand IS NOT NULL AND model_number IS NOT NULL AND
      // merged_into_product_id IS NULL`. The fold copies the sources'
      // brand/model_number onto the target, so while a source is still LIVE the
      // target and that source hold the same key — and a unique INDEX is not
      // deferrable, so it raises 23505 immediately and rolls the merge back.
      //
      // This is the ordinary case, not a corner: a barcode-only model (no
      // brand, no model_number) merged with the receipt-derived one that has
      // both is exactly what this method exists to repair.
      //
      // Setting `merged_into_product_id` FIRST drops every source out of the
      // index predicate, so the fold's key is unclaimed by the time it runs.
      //
      // `mergeObjects` has no equivalent hazard and needs no equivalent
      // reordering: `ci.objects`'s only unique indexes are `objects_pkey`
      // and `objects_source_triple_uniq` (owner + provenance triple), and
      // `foldObjectScalars` writes NEITHER a primary key nor any of
      // `source_type`/`source_system`/`source_id`.
      await em.query(
        `UPDATE ci.product_models
            SET merged_into_product_id = $3::uuid, updated_at = now()
          WHERE user_id = $1::uuid AND product_id = ANY($2::uuid[])`,
        [userId, sources, targetId],
      );

      await em.query(
        `UPDATE ci.product_models
            SET merged_into_product_id = $3::uuid, updated_at = now()
          WHERE user_id = $1::uuid AND merged_into_product_id = ANY($2::uuid[])`,
        [userId, sources, targetId],
      );

      await this.foldProductScalars(
        em,
        userId,
        target,
        sources.map((id) => byId.get(id) as ProductRow),
      );

      const searchRowsDeleted = await this.deleteSearchRows(em, userId, 'product', sources);

      const counts: ProductMergeCounts = {
        identifiers,
        receiptLineItems,
        objectProduct,
        observations,
        searchRowsDeleted,
      };

      for (const id of sources) {
        await em.query(
          `INSERT INTO ci.entity_merges
             (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)`,
          [
            userId,
            id,
            targetId,
            PRODUCT_MODEL_ENTITY_TYPE,
            JSON.stringify({ counts, source: byId.get(id) ?? {} }),
          ],
        );
      }

      this.logger.log(`Merged ${sources.length} product model(s) into ${targetId}`, { counts });

      return counts;
    });

    // After the commit, so the re-index reads the merged row rather than
    // racing the transaction that produced it. Only the target: a source is a
    // tombstone now, its search rows are already gone, and every read path
    // filters it — an event for one can do nothing but log a miss.
    await this.eventService.send(ProductUpdatedEvent, { productId: targetId });

    const entity = await this.productRepository.findOne({
      where: { id: targetId, userId: context.userId },
    });

    if (entity == null) {
      throw new NotFoundException(`Merge target ${targetId} vanished mid-merge`);
    }

    return { target: entity, counts };
  }

  /** Target wins every non-NULL scalar; the jsonb bags merge with the target on top. */
  private async foldProductScalars(
    em: EntityManager,
    userId: string,
    target: ProductRow,
    sources: ProductRow[],
  ): Promise<void> {
    const all = [target, ...sources];

    const firstNonNull = <K extends keyof ProductRow>(key: K): ProductRow[K] | null => {
      for (const row of all) {
        const value = row[key];

        if (value != null && value !== '') {
          return value;
        }
      }

      return null;
    };

    const mergeBags = (key: 'variant_attributes' | 'spec' | 'metadata') =>
      JSON.stringify(Object.assign({}, ...sources.map((row) => row[key] ?? {}), target[key] ?? {}));

    await em.query(
      `UPDATE ci.product_models
          SET title              = COALESCE($3, title),
              brand              = $4,
              manufacturer       = $5,
              model_number       = $6,
              category           = $7,
              subcategory        = $8,
              product_type       = $9,
              description        = $10,
              msrp_minor         = $11::bigint,
              currency           = $12,
              image_content_id   = $13::uuid,
              product_entity_id  = $14::uuid,
              variant_attributes = $15::jsonb,
              spec               = $16::jsonb,
              metadata           = $17::jsonb,
              updated_at         = now()
        WHERE user_id = $1::uuid AND product_id = $2::uuid`,
      [
        userId,
        target.product_id,
        firstNonNull('title'),
        firstNonNull('brand'),
        firstNonNull('manufacturer'),
        firstNonNull('model_number'),
        firstNonNull('category'),
        firstNonNull('subcategory'),
        firstNonNull('product_type'),
        firstNonNull('description'),
        firstNonNull('msrp_minor'),
        firstNonNull('currency'),
        firstNonNull('image_content_id'),
        firstNonNull('product_entity_id'),
        mergeBags('variant_attributes'),
        mergeBags('spec'),
        mergeBags('metadata'),
      ],
    );
  }
}

/**
 * Run a counting write and get the number of rows it actually touched.
 *
 * ── Why every one of these is wrapped in a CTE ─────────────────────────────
 *
 * `EntityManager.query()` returns the driver's ROWS for a `SELECT` and for an
 * `INSERT … RETURNING`, but for an `UPDATE … RETURNING` or a
 * `DELETE … RETURNING` TypeORM's Postgres runner special-cases the command and
 * resolves the PAIR `[rows, rowCount]` instead
 * (`driver/postgres/PostgresQueryRunner.ts`). A bare `UPDATE … RETURNING 1`
 * therefore has `.length === 2` no matter how many rows it hit — including
 * ZERO — so counting it that way reports a constant.
 *
 * That is not cosmetic here: these numbers are written into
 * `ci.entity_merges.details`, which is the only record of what a merge moved
 * and the thing anyone reads when asking whether a merge did what it claimed. A
 * hardcoded 2 in that column is worse than no column.
 *
 * Nothing caught it, because the unit suite stubs `query` with a `jest.fn` that
 * returns a one-element array for anything containing `RETURNING 1` — a shape
 * the real driver never produces. `ObjectMergeService.integration.spec.ts` is
 * where these counts are now checked against rows.
 *
 * Wrapping as `WITH … AS (UPDATE … RETURNING 1) SELECT COUNT(*) FROM …` makes
 * the outer command a SELECT, which is the remedy `EstimateLocationStage`,
 * `GeocodeStage` and `PipelineRunService` all use for the same trap.
 */
async function countAffected(em: EntityManager, sql: string, params: unknown[]): Promise<number> {
  const [row] = await em.query<Array<{ count: number | string }>>(sql, params);

  return Number(row?.count ?? 0);
}

/** The earliest non-null date, or null when there is none. */
function earliest(dates: Array<Date | null>): Date | null {
  let out: Date | null = null;

  for (const date of dates) {
    if (date != null && (out == null || date.getTime() < out.getTime())) {
      out = date;
    }
  }

  return out;
}
