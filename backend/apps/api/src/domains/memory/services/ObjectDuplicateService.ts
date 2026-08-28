import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { BaseEntity } from '../entities/BaseEntity';
import { pairKey } from '../entities/EntityMergeBlockEntity';
import { type Item, ItemEntity } from '../entities/ItemEntity';

import { EntityMergeBlockService } from './EntityMergeBlockService';

/** Why a group was proposed, strongest first. */
export type ObjectDuplicateReason = 'identifier' | 'product_name' | 'brand_model';

export interface ObjectDuplicateGroup {
  reason: ObjectDuplicateReason;
  /** The shared normalized value the group collapsed on. */
  value: string;
  items: Item[];
  /**
   * Units sharing `value` in total, before {@link MAX_GROUP_SIZE} truncation.
   * Greater than `items.length` for the junk-value groups a bad import creates.
   */
  totalItems: number;
}

export interface ObjectDuplicatePage {
  groups: ObjectDuplicateGroup[];
  /**
   * Candidate groups matching the filter, counted in SQL BEFORE the per-group
   * rejection filtering below — the size of the queue, not a per-page promise.
   */
  totalCount: number;
  hasMore: boolean;
}

/**
 * Max units surfaced per group.
 *
 * A group far above this is one junk value — an importer that wrote the same
 * placeholder SKU on 900 rows — but dropping it entirely would put the worst
 * import artifacts permanently out of reach of the merge UI. The group is
 * returned truncated, carrying `totalItems` so the UI can say "showing 6 of
 * 900". Same reasoning, same number, as `PersonDuplicateService`.
 *
 * WHICH members survive the cut is not arbitrary when the caller passed
 * `objectIds`: see that parameter on {@link ObjectDuplicateService.findDuplicateGroups}.
 */
const MAX_GROUP_SIZE = 6;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Which `identifier_codes` bag keys count as an IDENTIFIER of the thing itself.
 *
 * The bag is a grab-bag: the importer also drops `order_id` and `quantity` in
 * it (`import/push/inputs.ts`) as the human-facing copy of the purchase. An
 * order id belongs to the ORDER, not to any one thing in it, so grouping on it
 * proposes every line of a multi-item order — jeans, shorts, pajama pants — as
 * one duplicate. Hence an allow-list rather than a deny-list: a key a future
 * importer invents is ignored here until someone decides it identifies a unit
 * or a model. Mirrors `ReceiptService.CODE_KEY_NAMESPACES`, aliases included.
 */
const IDENTIFIER_BAG_KEYS: readonly string[] = [
  'gtin',
  'upc',
  'ean',
  'isbn',
  'asin',
  'mpn',
  'sku',
  'serial',
  'imei',
  'vin',
];

/**
 * The `ci.object_identifiers` namespaces that identify a thing or its model.
 * `order_id` is a namespace there too (datasources may state it in
 * `metadata.Identifiers`), and is excluded for the reason above; `custom` is
 * excluded because nothing guarantees two custom codes mean the same thing.
 */
const IDENTIFIER_CLAIM_NAMESPACES: readonly string[] = [
  'gtin',
  'isbn',
  'asin',
  'mpn',
  'sku',
  'serial',
  'imei',
  'vin',
  'rfid',
  'qr',
];

/**
 * Shortest identifier worth grouping on, after normalization.
 *
 * Short codes ("1", "AA", "N/A") appear in `identifier_codes` bags as
 * placeholders far more often than as real identifiers, and grouping on one
 * proposes a merge of every unit that carried the placeholder.
 */
const MIN_IDENTIFIER_LENGTH = 6;

/** Rank used both for the SQL ordering and for the strictly-weaker suppression. */
const REASON_RANK: Readonly<Record<ObjectDuplicateReason, number>> = {
  identifier: 0,
  product_name: 1,
  brand_model: 2,
};

/**
 * Remove members until no rejected pair remains in the group.
 *
 * The review UI merges a group WHOLE — pick a target, everything else folds in
 * — so a group containing one rejected pair proposes that rejection again as
 * part of a bigger action. Members are kept greedily in rank order: each is
 * admitted only if it is unblocked against everyone already admitted, which for
 * a three-member group with one blocked pair keeps the part the user never
 * rejected instead of throwing the whole suggestion away.
 */
function dropBlocked(items: Item[], blocked: Set<string>): Item[] {
  if (blocked.size === 0) {
    return items;
  }

  const kept: Item[] = [];

  for (const item of items) {
    if (kept.every((other) => !blocked.has(pairKey(item.id, other.id)))) {
      kept.push(item);
    }
  }

  return kept;
}

/**
 * Duplicate-owned-unit candidate detection for the merge review UI.
 *
 * SUGGESTIONS ONLY. Nothing here merges anything — that stays a user decision,
 * executed by {@link ObjectMergeService}. The same instinct
 * `PersonDuplicateService` was built on, for the same reason: two rows that
 * look identical to a query are sometimes two real things (you own two of the
 * same mug), and there is no evidence in the database that can tell them apart.
 *
 * ── Why `ci.object_identifiers` cannot answer this ─────────────────────────
 *
 * The claim index is UNIQUE on `(owner, namespace, value_normalized,
 * qualifier)` and FIRST-WRITER-WINS, so when a second unit asserts a barcode
 * another unit already claims, the row is never inserted — the duplicate is
 * INVISIBLE in that table by construction. What survives is the raw assertion
 * in `ci.objects.identifier_codes`, the jsonb bag the importer has been
 * writing ASINs into since 2025-09. So the identifier rung unnests THAT, and
 * unions in the claim table so a unit whose bag is empty but whose claim won
 * still participates. Exactly the shape `PersonDuplicateService` uses for
 * emails and phones, and for exactly the same reason.
 *
 * ── Why the SQL normalization is approximate ───────────────────────────────
 *
 * It strips non-alphanumerics and uppercases; it does NOT zero-pad GTIN-14,
 * upconvert ISBN-10, or verify a check digit — `normalizeObjectIdentifier`
 * cannot be reimplemented in SQL byte-identically, and a divergence there is a
 * silent lookup miss. That is fatal for RESOLUTION and harmless here: this
 * query generates CANDIDATES for a human, so being slightly too generous costs
 * one glance and being slightly too strict costs one missed suggestion. The
 * authoritative normalization runs when the merge is actually performed.
 */
@Injectable()
export class ObjectDuplicateService {
  constructor(
    @InjectRepository(ItemEntity)
    private readonly itemRepository: Repository<ItemEntity>,
    private readonly mergeBlockService: EntityMergeBlockService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectDuplicateService.name);
  }

  /**
   * @param options.objectIds Restrict the answer to groups that CONTAIN at
   * least one of these units. Membership is still resolved corpus-wide — the
   * unit a slice's duplicate pairs with is usually not in the same slice — so
   * this narrows WHICH groups come back and never which units may join one.
   * Added for `clean.object_duplicate_detect`, which sweeps `ci.objects` a
   * ledger slice at a time and would otherwise have to page the whole corpus to
   * find the handful of groups its 200 ids are in. Absent (or empty) means the
   * whole corpus, which is what the review UI asks for.
   *
   * A group returned for a slice always CONTAINS at least one of these units:
   * {@link MAX_GROUP_SIZE} truncation orders them first, so a unit cannot both
   * select a group and be cut out of the membership that comes back — the
   * sweep would otherwise record it as examined with no duplicate, and the
   * ledger would not ask again until a version bump.
   */
  async findDuplicateGroups(
    context: UserServiceContext,
    options: {
      limit?: number;
      offset?: number;
      reasons?: ObjectDuplicateReason[];
      objectIds?: string[];
    } = {},
  ): Promise<ObjectDuplicatePage> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);
    // An empty (or absent) filter means every reason; the SQL takes NULL for it
    // so one statement serves both.
    const reasons = options.reasons?.length ? [...new Set(options.reasons)] : null;
    const objectIds = options.objectIds?.length ? [...new Set(options.objectIds)] : null;

    const rows: Array<{
      kind: ObjectDuplicateReason;
      val: string;
      object_ids: string[];
      n: number | string;
      total: number | string;
    }> = await this.itemRepository.manager.query(
      `WITH units AS (
           SELECT inv.object_id,
                  inv.product_id,
                  inv.brand,
                  inv.model,
                  inv.acquired_at,
                  inv.identifier_codes,
                  base.name
             FROM ci.objects inv
             JOIN ci.entities base ON base.entity_id = inv.object_id
            WHERE inv.user_id = $1::uuid
              -- Live only. A tombstone has already been folded into its
              -- survivor, so proposing it again would re-open a settled merge.
              AND inv.merged_into_object_id IS NULL
              AND base.is_active IS DISTINCT FROM FALSE
              AND base.merged_into_entity_id IS NULL
         ),
         keys AS (
           -- (a) A shared identifier value, from the raw assertion bag.
           SELECT u.object_id, 'identifier'::text AS kind,
                  upper(regexp_replace(code.value, '[^0-9A-Za-z]', '', 'g')) AS val
             FROM units u,
                  LATERAL jsonb_each_text(
                    CASE WHEN jsonb_typeof(u.identifier_codes) = 'object'
                         THEN u.identifier_codes ELSE '{}'::jsonb END) AS code(key, value)
            WHERE lower(btrim(code.key)) = ANY($7::text[])
              AND length(regexp_replace(code.value, '[^0-9A-Za-z]', '', 'g')) >= $6
           UNION ALL
           -- ...and from the claim table, so a unit that WON a claim but never
           -- kept the raw code in its bag is still in the group.
           SELECT oi.subject_id, 'identifier',
                  upper(regexp_replace(oi.value_normalized, '[^0-9A-Za-z]', '', 'g'))
             FROM ci.object_identifiers oi
             JOIN units u ON u.object_id = oi.subject_id
            WHERE oi.owner_user_id = $1::uuid
              AND oi.subject_type = 'object_instance'
              AND oi.namespace = ANY($8::text[])
              AND length(regexp_replace(oi.value_normalized, '[^0-9A-Za-z]', '', 'g')) >= $6
           UNION ALL
           -- (b) Same catalog model AND same name: two rows claiming to be the
           -- same product, called the same thing.
           SELECT u.object_id, 'product_name',
                  u.product_id::text || '|' || lower(btrim(regexp_replace(u.name, '\\s+', ' ', 'g')))
             FROM units u
            WHERE u.product_id IS NOT NULL
              AND u.name IS NOT NULL
              AND length(btrim(u.name)) >= 2
           UNION ALL
           -- (c) Same brand and model, acquired the same DAY. The date is what
           -- makes this a duplicate signal rather than a "you own two" signal:
           -- buying the same model twice on the same day is far more often one
           -- purchase imported twice than two purchases.
           SELECT u.object_id, 'brand_model',
                  lower(btrim(u.brand)) || '|' || lower(btrim(u.model)) || '|' ||
                  to_char(u.acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
             FROM units u
            WHERE u.brand IS NOT NULL AND btrim(u.brand) <> ''
              AND u.model IS NOT NULL AND btrim(u.model) <> ''
              AND u.acquired_at IS NOT NULL
         ),
         members AS (
           -- One row per (group, unit). Deduplicated HERE rather than by
           -- array_agg(DISTINCT ...) below, because an aggregate carrying
           -- DISTINCT may only be ordered by its own argument and the
           -- truncation below has to be ordered by the slice predicate.
           SELECT DISTINCT kind, val, object_id
             FROM keys
            WHERE $4::text[] IS NULL OR kind = ANY($4::text[])
         ),
         grouped AS (
           SELECT kind, val,
                  -- The slice's own units aggregate FIRST, so the truncation
                  -- can never cut away the unit the group was selected for —
                  -- which would hand the caller a group that does not contain
                  -- what it asked about. With no slice the predicate is NULL
                  -- for every row and the order falls back to object_id, as it
                  -- did when this was array_agg(DISTINCT ...).
                  (array_agg(object_id
                             ORDER BY (object_id = ANY($9::uuid[])) DESC NULLS LAST,
                                      object_id))[1:$3] AS object_ids,
                  COUNT(*) AS n
             FROM members
            GROUP BY kind, val
           HAVING COUNT(*) > 1
              -- The slice filter, applied AFTER the group is formed. Filtering
              -- the units CTE instead would ask a different question: whether
              -- the slice's units duplicate EACH OTHER, which for a 200-row
              -- slice of a 30,000-row corpus is almost never where it is.
              AND ($9::uuid[] IS NULL OR bool_or(object_id = ANY($9::uuid[])))
         )
         SELECT kind, val, object_ids, n, COUNT(*) OVER () AS total
           FROM grouped
          ORDER BY CASE kind WHEN 'identifier' THEN 0 WHEN 'product_name' THEN 1 ELSE 2 END,
                   n DESC,
                   val ASC
          LIMIT $2 OFFSET $5`,
      [
        context.userId,
        limit + 1,
        MAX_GROUP_SIZE,
        reasons,
        offset,
        MIN_IDENTIFIER_LENGTH,
        IDENTIFIER_BAG_KEYS,
        IDENTIFIER_CLAIM_NAMESPACES,
        objectIds,
      ],
    );

    if (rows.length === 0) {
      return { groups: [], totalCount: 0, hasMore: false };
    }

    const totalCount = Number(rows[0].total ?? rows.length);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const allIds = [...new Set(page.flatMap((row) => row.object_ids))];
    const items = await this.loadItems(context, allIds);
    const byId = new Map(items.map((item) => [item.id, item]));

    // Pairs the user has already said are NOT the same thing. Fetched once for
    // the whole sweep rather than per group. `ci.entity_merge_blocks` is
    // entity-agnostic by design, and a ci.objects object_id IS an entity id
    // (the CTI base row shares it), so no object-specific table is needed.
    const blocked = await this.mergeBlockService.blockedPairsAmong(context, allIds);

    const groups: ObjectDuplicateGroup[] = [];
    // A pair that shares an identifier almost always shares the brand+model
    // too; suppress the strictly-weaker group that adds no new members over one
    // already accepted. Ordering by REASON_RANK above guarantees the STRONGER
    // reason is seen first, so the surviving group is the one that explains the
    // duplicate best.
    const seenMemberSets = new Set<string>();

    for (const row of page) {
      const candidates = dropBlocked(
        row.object_ids.map((id) => byId.get(id)).filter((item): item is Item => item != null),
        blocked,
      );

      if (candidates.length < 2) {
        continue;
      }

      const memberKey = candidates
        .map((item) => item.id)
        .sort()
        .join(',');

      if (seenMemberSets.has(memberKey)) {
        continue;
      }

      seenMemberSets.add(memberKey);

      groups.push({
        reason: row.kind,
        value: row.val,
        items: candidates,
        totalItems: Math.max(Number(row.n), candidates.length),
      });
    }

    groups.sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason]);

    return { groups, totalCount, hasMore };
  }

  /**
   * Hydrate the candidate units, composing name/description from the CTI base
   * row in the SAME query — the 1:1 join yields one raw row per entity in the
   * same order, so the base columns compose positionally and no second fetch is
   * needed.
   */
  private async loadItems(context: UserServiceContext, ids: string[]): Promise<Item[]> {
    if (ids.length === 0) {
      return [];
    }

    const { entities, raw } = await this.itemRepository
      .createQueryBuilder('item')
      .innerJoin(BaseEntity, 'base', 'base.entity_id = item.object_id')
      .addSelect('base.name', 'base_name')
      .addSelect('base.description', 'base_description')
      .where('item.user_id = :userId', { userId: context.userId })
      .andWhere('item.object_id IN (:...ids)', { ids })
      .getRawAndEntities<{ base_name: string | null; base_description: string | null }>();

    return entities.map((entity, index) =>
      ItemEntity.toEgressType(entity, {
        name: raw[index]?.base_name ?? null,
        description: raw[index]?.base_description ?? null,
      }),
    );
  }
}
